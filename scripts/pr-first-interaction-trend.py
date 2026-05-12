#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "matplotlib>=3.8",
# ]
# ///
"""Plot a rolling average of time-to-first-human-interaction for PRs.

Uses `gh api graphql` (so it reuses your existing gh auth). Fetches every PR
you've authored in the given scope, finds the earliest comment or review by
anyone who isn't you and isn't a bot, and plots a rolling average over time.

Run: ./scripts/pr-first-interaction-trend.py (--org ORG | --repo OWNER/NAME)
                                              [--user USER]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from collections import deque
from dataclasses import dataclass

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np


GRAPHQL_QUERY = """
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        createdAt
        url
        state
        isDraft
        author { login __typename }
        repository { nameWithOwner }
        comments(first: 50) {
          nodes { createdAt author { login __typename } }
        }
        reviews(first: 50) {
          nodes { createdAt author { login __typename } }
        }
        timelineItems(last: 50, itemTypes: [READY_FOR_REVIEW_EVENT]) {
          nodes {
            ... on ReadyForReviewEvent { createdAt }
          }
        }
      }
    }
  }
}
"""


@dataclass
class PR:
    number: int
    repo: str
    url: str
    state: str
    created_at: dt.datetime
    review_start_at: dt.datetime
    first_interaction_at: dt.datetime | None
    pending: bool = False

    @property
    def hours_to_first(self) -> float | None:
        if self.first_interaction_at is None:
            return None
        return weekday_hours(self.review_start_at, self.first_interaction_at)


def parse_ts(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def weekday_hours(start: dt.datetime, end: dt.datetime) -> float:
    """Hours between start and end, counting only Mon-Fri (UTC)."""
    if end <= start:
        return 0.0
    total = 0.0
    cur = start
    while cur < end:
        next_midnight = (
            cur.replace(hour=0, minute=0, second=0, microsecond=0)
            + dt.timedelta(days=1)
        )
        chunk_end = min(next_midnight, end)
        if cur.weekday() < 5:
            total += (chunk_end - cur).total_seconds() / 3600.0
        cur = chunk_end
    return total


def gh_graphql(query: str, variables: dict) -> dict:
    cmd = ["gh", "api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        if v is None:
            cmd += ["-F", f"{k}="]
        else:
            cmd += ["-f", f"{k}={v}"]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        sys.stderr.write(f"gh failed: {result.stderr}\n")
        sys.exit(1)
    data = json.loads(result.stdout)
    if "errors" in data:
        sys.stderr.write(f"graphql errors: {data['errors']}\n")
        sys.exit(1)
    return data["data"]


def first_human_interaction(
    pr_node: dict, author_login: str, since: dt.datetime,
) -> dt.datetime | None:
    times: list[dt.datetime] = []
    for bucket in ("comments", "reviews"):
        for node in pr_node.get(bucket, {}).get("nodes", []) or []:
            author = node.get("author") or {}
            login = author.get("login")
            typename = author.get("__typename")
            if not login or login == author_login:
                continue
            if typename != "User":
                continue
            ts = parse_ts(node["createdAt"])
            if ts < since:
                continue
            times.append(ts)
    return min(times) if times else None


def latest_ready_for_review(pr_node: dict) -> dt.datetime | None:
    nodes = pr_node.get("timelineItems", {}).get("nodes", []) or []
    times = [parse_ts(n["createdAt"]) for n in nodes if n and n.get("createdAt")]
    return max(times) if times else None


def fetch_prs(user: str, org: str, repo: str | None) -> list[PR]:
    scope = f"repo:{repo}" if repo else f"org:{org}"
    q = f"is:pr author:{user} {scope} sort:created-asc"
    prs: list[PR] = []
    cursor: str | None = None
    skipped_drafts = 0
    now = dt.datetime.now(tz=dt.timezone.utc)
    while True:
        data = gh_graphql(GRAPHQL_QUERY, {"q": q, "cursor": cursor})
        search = data["search"]
        for node in search["nodes"]:
            if not node:
                continue
            if node.get("isDraft"):
                skipped_drafts += 1
                continue
            pr_author = (node.get("author") or {}).get("login") or user
            created_at = parse_ts(node["createdAt"])
            ready_at = latest_ready_for_review(node)
            review_start = ready_at if ready_at else created_at
            first = first_human_interaction(node, pr_author, review_start)
            state = node["state"]
            pending = False
            if first is None and state == "OPEN":
                first = now
                pending = True
            prs.append(PR(
                number=node["number"],
                repo=node["repository"]["nameWithOwner"],
                url=node["url"],
                state=state,
                created_at=created_at,
                review_start_at=review_start,
                first_interaction_at=first,
                pending=pending,
            ))
        sys.stderr.write(
            f"fetched {len(prs)} / {search['issueCount']} PRs "
            f"({skipped_drafts} draft(s) skipped so far)\n"
        )
        if not search["pageInfo"]["hasNextPage"]:
            break
        cursor = search["pageInfo"]["endCursor"]
    if skipped_drafts:
        sys.stderr.write(
            f"note: skipped {skipped_drafts} PR(s) still in draft\n"
        )
    return prs


def rolling_average(values: list[float], window: int) -> list[float | None]:
    out: list[float | None] = []
    buf: deque[float] = deque(maxlen=window)
    for v in values:
        buf.append(v)
        out.append(sum(buf) / len(buf))
    return out


def ewma(values: list[float], alpha: float) -> list[float]:
    """Exponentially weighted moving average. Higher alpha = more reactive."""
    out: list[float] = []
    prev = None
    for v in values:
        prev = v if prev is None else alpha * v + (1 - alpha) * prev
        out.append(prev)
    return out


def smooth_trend(values: list[float], alpha: float, passes: int = 2,
                 power: float = 1.0) -> list[float]:
    """Multi-pass forward+backward EWMA, optionally on values raised to
    `power` then rooted back. power=1 -> arithmetic-mean style; power=2 ->
    RMS (smooth but pulled visibly upward by outliers); power=3 -> dominated
    by extremes. Always returns positive values."""
    if power != 1.0:
        out = [abs(v) ** power for v in values]
    else:
        out = list(values)
    for _ in range(passes):
        fwd = ewma(out, alpha)
        bwd = list(reversed(ewma(list(reversed(out)), alpha)))
        out = [(f + b) / 2 for f, b in zip(fwd, bwd)]
    if power != 1.0:
        out = [max(v, 0.0) ** (1.0 / power) for v in out]
    return out


def plot(prs: list[PR], smoothing: float, passes: int, power: float,
         out_path: str, user: str, scope: str, gap_days: float,
         since: dt.datetime | None) -> None:
    full = [p for p in prs if p.hours_to_first is not None]
    full.sort(key=lambda p: p.review_start_at)
    if not full:
        sys.stderr.write("no PRs with a human interaction found\n")
        sys.exit(1)

    full_dates = [p.review_start_at for p in full]
    full_hours = [p.hours_to_first for p in full]
    full_trend = smooth_trend(full_hours, smoothing, passes=passes,
                              power=power)

    # Compute trend & baseline on the full history, then slice for display so
    # the first weeks after --since still have a meaningful "past" reference.
    if since is not None:
        display_start = next(
            (i for i, p in enumerate(full) if p.review_start_at >= since),
            len(full),
        )
    else:
        display_start = 0
    measured = full[display_start:]
    if not measured:
        sys.stderr.write("no PRs in the display window\n")
        sys.exit(1)
    dates = full_dates[display_start:]
    hours = full_hours[display_start:]
    trend = full_trend[display_start:]

    gap_threshold = dt.timedelta(days=gap_days)
    gap_after = [False] * len(dates)  # gap_after[i] => break before drawing i
    gaps: list[tuple[dt.datetime, dt.datetime]] = []
    for i in range(1, len(dates)):
        if dates[i] - dates[i - 1] > gap_threshold:
            gap_after[i] = True
            gaps.append((dates[i - 1], dates[i]))
    # A gap straddling the --since boundary also visually severs the display
    # window from history; show it in the leading margin if it exists.
    if since is not None and display_start > 0:
        prev = full_dates[display_start - 1]
        cur = full_dates[display_start]
        if cur - prev > gap_threshold:
            gaps.append((prev, cur))

    settled_dates = [p.review_start_at for p in measured if not p.pending]
    settled_hours = [p.hours_to_first for p in measured if not p.pending]
    pending_dates = [p.review_start_at for p in measured if p.pending]
    pending_hours = [p.hours_to_first for p in measured if p.pending]

    plt.rcParams.update({
        "font.family": "sans-serif",
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.edgecolor": "#cccccc",
    })
    fig, ax = plt.subplots(figsize=(12, 6), facecolor="#fbf8f1")
    ax.set_facecolor("#fbf8f1")

    for start, end in gaps:
        ax.axvspan(start, end, color="#e8e2d4", alpha=0.55, zorder=0)

    BLUE = "#3a86c9"

    n = len(trend)
    x_num = np.array(mdates.date2num(dates))

    # Stems: thin lines from each per-PR dot to the trend
    for i in range(n):
        ax.plot([x_num[i], x_num[i]], [hours[i], trend[i]],
                color=BLUE, linewidth=0.8, alpha=0.35, zorder=3)

    settled_x = [x_num[i] for i, p in enumerate(measured) if not p.pending]
    pending_x = [x_num[i] for i, p in enumerate(measured) if p.pending]
    ax.scatter(settled_x, settled_hours, s=18, color=BLUE,
               edgecolors="none", zorder=4, label="per-PR (reviewed)")
    if pending_x:
        ax.scatter(pending_x, pending_hours, s=22, color=BLUE,
                   marker="^", edgecolors="none", zorder=4,
                   label="per-PR (still open, age-to-now)")

    trend_plot = [float("nan") if (i > 0 and gap_after[i]) else trend[i]
                  for i in range(n)]
    ax.plot(x_num, trend_plot, color=BLUE, linewidth=3,
            solid_capstyle="round", zorder=5, label="trend (EWMA)")

    if gaps:
        ax.plot([], [], color="#cfc6b3", linewidth=8,
                label=f"gap (>{gap_days:g} days)")

    ax.set_ylim(bottom=0)
    ax.set_ylabel("weekday hours to first human interaction")
    ax.set_xlabel("PR ready-for-review at")
    ax.set_title(
        f"Time to first human interaction - {user} in {scope} "
        f"({len(measured)} PRs, smoothing alpha={smoothing:g})"
    )
    ax.xaxis.set_major_locator(mdates.AutoDateLocator())
    ax.xaxis.set_major_formatter(mdates.ConciseDateFormatter(
        ax.xaxis.get_major_locator()))
    ax.grid(True, which="major", axis="y", alpha=0.25, linestyle="-",
            color="#dddddd")
    ax.grid(False, axis="x")
    ax.tick_params(colors="#666", which="both")
    leg = ax.legend(loc="upper left", frameon=False, fontsize=9)
    for text in leg.get_texts():
        text.set_color("#444")
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    sys.stderr.write(f"wrote {out_path}\n")

    pending_count = sum(1 for p in measured if p.pending)
    if pending_count:
        sys.stderr.write(
            f"note: {pending_count} open PR(s) counted as if reviewed now\n"
        )
    visible_prs = [p for p in prs if since is None or p.review_start_at >= since]
    skipped = len(visible_prs) - len(measured)
    if skipped:
        sys.stderr.write(
            f"note: {skipped} closed/merged PR(s) in display window excluded "
            "(no human interaction ever happened)\n"
        )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--user", help="GitHub login (defaults to `gh api user`)")
    scope = ap.add_mutually_exclusive_group(required=True)
    scope.add_argument("--org", help="GitHub org to scope to")
    scope.add_argument("--repo", help="GitHub repo to scope to (owner/name)")
    ap.add_argument("--since", help="ignore PRs that became ready before "
                                    "this date (YYYY-MM-DD, UTC)")
    ap.add_argument("--smoothing", type=float, default=0.10,
                    help="EWMA smoothing factor 0<alpha<1 "
                         "(lower = smoother, default 0.10)")
    ap.add_argument("--smoothing-passes", type=int, default=1,
                    help="forward+backward EWMA passes (default 1)")
    ap.add_argument("--outlier-power", type=float, default=1.0,
                    help="aggregate values via p-mean; 1=arithmetic mean "
                         "(default; outliers cause visible bumps), 2=RMS, "
                         ">2 lifts trend above typical values")
    ap.add_argument("--gap-days", type=float, default=7.0,
                    help="break the rolling avg line and shade if there's no "
                         "PR for more than this many days (default 7)")
    ap.add_argument("--out", default="pr-first-interaction-trend.png")
    ap.add_argument("--dump-json",
                    help="optional path to write raw per-PR data")
    args = ap.parse_args()

    user = args.user
    if not user:
        user = subprocess.check_output(
            ["gh", "api", "user", "--jq", ".login"], text=True
        ).strip()

    prs = fetch_prs(user, args.org, args.repo)
    scope_label = args.repo if args.repo else args.org

    since_dt: dt.datetime | None = None
    if args.since:
        try:
            since_dt = dt.datetime.strptime(args.since, "%Y-%m-%d").replace(
                tzinfo=dt.timezone.utc)
        except ValueError:
            sys.stderr.write(f"bad --since {args.since!r}, expected YYYY-MM-DD\n")
            sys.exit(2)
        visible = sum(1 for p in prs if p.review_start_at >= since_dt)
        sys.stderr.write(
            f"--since {args.since}: displaying {visible} / {len(prs)} PRs "
            "(earlier history kept for baseline reference)\n"
        )
    if args.dump_json:
        with open(args.dump_json, "w") as f:
            json.dump([{
                "number": p.number,
                "repo": p.repo,
                "url": p.url,
                "state": p.state,
                "pending": p.pending,
                "created_at": p.created_at.isoformat(),
                "review_start_at": p.review_start_at.isoformat(),
                "first_interaction_at":
                    p.first_interaction_at.isoformat()
                    if p.first_interaction_at else None,
                "hours_to_first": p.hours_to_first,
            } for p in prs], f, indent=2)
    if not 0 < args.smoothing < 1:
        sys.stderr.write("--smoothing must be in (0, 1)\n")
        sys.exit(2)
    if args.smoothing_passes < 1:
        sys.stderr.write("--smoothing-passes must be >= 1\n")
        sys.exit(2)
    if args.outlier_power < 1:
        sys.stderr.write("--outlier-power must be >= 1\n")
        sys.exit(2)
    plot(prs, args.smoothing, args.smoothing_passes, args.outlier_power,
         args.out, user, scope_label, args.gap_days, since_dt)


if __name__ == "__main__":
    main()
