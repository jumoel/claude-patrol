import { useCallback, useEffect, useState } from 'react';
import {
  fetchPRRuleSubscriptions,
  fetchRules,
  runRuleForAll,
  runRuleManually,
  subscribeRuleForPR,
  unsubscribeRuleForPR,
} from '../../lib/api.js';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './RuleControls.module.css';

/**
 * Per-PR rule controls. Lists rules relevant to PRs:
 *   - rules with `requires_subscription: true` get a subscribe/unsubscribe toggle
 *   - all PR-eligible rules get a "Run now" button (manual fire)
 *
 * @param {{ prId: string }} props
 */
export function RuleControls({ prId }) {
  const [allRules, setAllRules] = useState([]);
  const [ruleErrors, setRuleErrors] = useState([]);
  const [subscriptions, setSubscriptions] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [busyRule, setBusyRule] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [data, subs] = await Promise.all([fetchRules(), fetchPRRuleSubscriptions(prId)]);
      setAllRules(data.rules || []);
      setRuleErrors(data.errors || []);
      setSubscriptions(new Set(subs.map((s) => s.rule_id)));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [prId]);

  const PR_TRIGGERS = ['ci.finalized', 'mergeable.changed', 'labels.changed', 'draft.changed'];
  const rules = allRules.filter((r) => PR_TRIGGERS.includes(r.on));

  useEffect(() => {
    load();
  }, [load]);

  // Refresh subscriptions when a rule_run completes successfully against this
  // PR - one_shot rules consume their subscription on success and the UI needs
  // to flip the badge from "Armed" back to "Not subscribed" without a manual reload.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('rule-run', (e) => {
      try {
        const run = JSON.parse(e.data);
        if (run?.pr_id === prId && run.status === 'success' && run.ended_at) {
          load();
        }
      } catch {
        /* ignore */
      }
    });
    return () => source.close();
  }, [prId, load]);

  const toggleSubscription = useCallback(
    async (rule) => {
      setBusyRule(rule.id);
      setError(null);
      try {
        if (subscriptions.has(rule.id)) {
          await unsubscribeRuleForPR(rule.id, prId);
        } else {
          await subscribeRuleForPR(rule.id, prId);
        }
        await load();
      } catch (err) {
        setError(err.message);
      } finally {
        setBusyRule(null);
      }
    },
    [subscriptions, prId, load],
  );

  const fireRule = useCallback(
    async (rule) => {
      setBusyRule(rule.id);
      setError(null);
      try {
        await runRuleManually(rule.id, { pr_id: prId, force: true });
      } catch (err) {
        setError(err.message);
      } finally {
        setBusyRule(null);
      }
    },
    [prId],
  );

  const fireForAll = useCallback(async (rule) => {
    const subscribe =
      rule.requires_subscription === true &&
      window.confirm(
        `Run "${rule.id}" for ALL matching PRs?\n\nThis rule requires subscription. Click OK to auto-subscribe and fire on every match. Cancel to abort.`,
      );
    if (rule.requires_subscription === true && !subscribe) return;
    if (
      rule.requires_subscription !== true &&
      !window.confirm(`Run "${rule.id}" for ALL matching PRs? Cooldown still applies per-PR.`)
    ) {
      return;
    }
    setBusyRule(rule.id);
    setError(null);
    try {
      const result = await runRuleForAll(rule.id, { subscribe });
      const fired = result.fired?.length ?? 0;
      const skipped = result.skipped?.length ?? 0;
      window.alert(`Fired: ${fired}\nSkipped: ${skipped}\n\nWatch the dashboard Rules dropdown for results.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyRule(null);
    }
  }, []);

  if (loading) return null;

  if (error) {
    return <p className={styles.error}>Could not load rules: {error}</p>;
  }

  if (rules.length === 0) {
    const sessionRuleCount = allRules.length;
    return (
      <Stack direction="col" gap={2}>
        {sessionRuleCount === 0 && ruleErrors.length === 0 && (
          <p className={styles.empty}>
            No rules configured. Add a rule with <code>on: "ci.finalized"</code> in <code>config.json</code> to enable per-PR
            automation - see the README for examples.
          </p>
        )}
        {sessionRuleCount > 0 && (
          <p className={styles.empty}>
            {sessionRuleCount} rule(s) loaded, but none target PRs.
          </p>
        )}
        {ruleErrors.length > 0 && (
          <p className={styles.error}>
            {ruleErrors.length} rule(s) failed to load. See the Rules dropdown in the dashboard summary for details.
          </p>
        )}
      </Stack>
    );
  }

  return (
    <Stack direction="col" gap={3}>
      {rules.map((rule) => {
        const isBusy = busyRule === rule.id;
        const isSubscribed = subscriptions.has(rule.id);
        const isManual = rule.manual === true;
        const requiresSubscription = rule.requires_subscription === true;
        const isOneShot = rule.one_shot === true;
        return (
          <div key={rule.id} className={styles.row}>
            <Stack gap={2} align="center">
              <span className={styles.name}>{rule.id}</span>
              {isManual && <Badge color="gray">Manual only</Badge>}
              {requiresSubscription && isSubscribed && (
                <Badge color="green">{isOneShot ? 'Armed (fires once)' : 'Subscribed'}</Badge>
              )}
              {requiresSubscription && !isSubscribed && <Badge color="amber">Not subscribed</Badge>}
              {!requiresSubscription && !isManual && <Badge color="violet">Auto on all</Badge>}
              {isOneShot && !isSubscribed && <Badge color="gray">One-shot</Badge>}
            </Stack>
            <Stack gap={2}>
              {requiresSubscription && (
                <Button size="sm" onClick={() => toggleSubscription(rule)} disabled={isBusy}>
                  {isSubscribed ? 'Unsubscribe' : isOneShot ? 'Arm' : 'Subscribe'}
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={() => fireRule(rule)} disabled={isBusy}>
                {isBusy ? 'Running...' : 'Run now'}
              </Button>
              <Button size="sm" onClick={() => fireForAll(rule)} disabled={isBusy} title="Fire this rule against every PR matching its where clause">
                Run for all matching
              </Button>
            </Stack>
          </div>
        );
      })}
      {error && <p className={styles.error}>{error}</p>}
    </Stack>
  );
}
