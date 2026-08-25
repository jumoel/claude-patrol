import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchPRRuleSubscriptions,
  fetchRules,
  runRuleManually,
  subscribeRuleForPR,
  unsubscribeRuleForPR,
} from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { subscribeAppEvent } from '../../lib/event-stream.js';
import shared from '../../styles/shared.module.css';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
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
  const [allRules, setAllRules] = useState(/** @type {import('../../types').RuleDefinition[]} */ ([]));
  const [ruleErrors, setRuleErrors] = useState(/** @type {import('../../types').RuleLoadError[]} */ ([]));
  const [subscriptions, setSubscriptions] = useState(new Set(/** @type {string[]} */ ([])));
  const [loading, setLoading] = useState(true);
  const [busyRule, setBusyRule] = useState(/** @type {{id: string, action: 'subscription' | 'run'} | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [expanded, setExpanded] = useState(false);
  const initializedPrRef = useRef(/** @type {string | null} */ (null));

  const load = useCallback(async () => {
    setError(null);
    try {
      const [data, subs] = await Promise.all([fetchRules(), fetchPRRuleSubscriptions(prId)]);
      const nextSubscriptions = new Set(subs.map((subscription) => subscription.rule_id));
      setAllRules(data.rules || []);
      setRuleErrors(data.errors || []);
      setSubscriptions(nextSubscriptions);
      if (initializedPrRef.current !== prId) {
        setExpanded(nextSubscriptions.size > 0);
        initializedPrRef.current = prId;
      }
    } catch (err) {
      setError(getErrorMessage(err));
      if (initializedPrRef.current !== prId) {
        setExpanded(true);
        initializedPrRef.current = prId;
      }
    } finally {
      setLoading(false);
    }
  }, [prId]);

  const PR_TRIGGERS = ['ci.finalized', 'mergeable.changed', 'labels.changed', 'draft.changed'];
  const rules = allRules.filter((r) => PR_TRIGGERS.includes(r.on));

  useEffect(() => {
    setLoading(true);
    initializedPrRef.current = null;
    load();
  }, [load]);

  // Refresh subscriptions when a rule_run completes successfully against this
  // PR - consume_on rules consume their subscription on success/trigger and the UI needs
  // to flip the badge from "Armed" back to "Not subscribed" without a manual reload.
  useEffect(() => {
    return subscribeAppEvent('rule-run', (e) => {
      try {
        /** @type {import('../../types').RuleRun} */
        const run = JSON.parse(e.data);
        if (run?.pr_id === prId && run.status === 'success' && run.ended_at) {
          load();
        }
      } catch {
        /* ignore */
      }
    });
  }, [prId, load]);

  const toggleSubscription = useCallback(
    /** @param {import('../../types').RuleDefinition} rule */
    async (rule) => {
      setBusyRule({ id: rule.id, action: 'subscription' });
      setError(null);
      try {
        if (subscriptions.has(rule.id)) {
          await unsubscribeRuleForPR(rule.id, prId);
        } else {
          await subscribeRuleForPR(rule.id, prId);
        }
        await load();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setBusyRule(null);
      }
    },
    [subscriptions, prId, load],
  );

  const fireRule = useCallback(
    /** @param {import('../../types').RuleDefinition} rule */
    async (rule) => {
      setBusyRule({ id: rule.id, action: 'run' });
      setError(null);
      try {
        await runRuleManually(rule.id, { pr_id: prId, force: true });
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setBusyRule(null);
      }
    },
    [prId],
  );

  const subscriptionCount = subscriptions.size;
  const summary = loading ? (
    <LoadingIndicator as="span">Loading...</LoadingIndicator>
  ) : error ? (
    'Could not load rules'
  ) : rules.length === 0 ? (
    'No PR rules'
  ) : (
    `${rules.length} available`
  );

  let content = null;
  if (error) {
    content = <p className={styles.error}>Could not load rules: {error}</p>;
  } else if (rules.length === 0) {
    const sessionRuleCount = allRules.length;
    content = (
      <Stack direction="col" gap={2}>
        {sessionRuleCount === 0 && ruleErrors.length === 0 && (
          <p className={styles.empty}>
            No rules configured. Add a rule with <code>on: "ci.finalized"</code> in <code>config.json</code> to enable
            per-PR automation - see the README for examples.
          </p>
        )}
        {sessionRuleCount > 0 && (
          <p className={styles.empty}>{sessionRuleCount} rule(s) loaded, but none target PRs.</p>
        )}
        {ruleErrors.length > 0 && (
          <p className={styles.error}>
            {ruleErrors.length} rule(s) failed to load. See the Rules dropdown in the dashboard summary for details.
          </p>
        )}
      </Stack>
    );
  } else {
    content = (
      <Stack direction="col">
        {rules.map((rule) => {
          const isBusy = busyRule?.id === rule.id;
          const subscriptionBusy = isBusy && busyRule.action === 'subscription';
          const runBusy = isBusy && busyRule.action === 'run';
          const isSubscribed = subscriptions.has(rule.id);
          const isManual = rule.manual === true;
          const requiresSubscription = rule.requires_subscription === true;
          const consumeOn = rule.consume_on; // 'fire' | 'trigger' | undefined
          const isConsumable = consumeOn === 'fire' || consumeOn === 'trigger';
          const armedLabel =
            consumeOn === 'fire' ? 'Armed (fires once)' : consumeOn === 'trigger' ? 'Armed (next trigger only)' : null;
          return (
            <div key={rule.id} className={styles.row}>
              <div className={styles.identity}>
                <span className={styles.name}>{rule.id}</span>
                <span className={styles.trigger}>on {rule.on}</span>
              </div>
              <Stack gap={2} align="center" className={styles.status}>
                {isManual && <Badge color="gray">Manual only</Badge>}
                {requiresSubscription && isSubscribed && <Badge color="green">{armedLabel ?? 'Subscribed'}</Badge>}
                {requiresSubscription && !isSubscribed && <Badge color="amber">Not subscribed</Badge>}
                {!requiresSubscription && !isManual && <Badge color="violet">Auto on all</Badge>}
              </Stack>
              <Stack gap={2} className={styles.actions}>
                {requiresSubscription && (
                  <Button size="sm" onClick={() => toggleSubscription(rule)} disabled={isBusy} busy={subscriptionBusy}>
                    {subscriptionBusy
                      ? 'Updating...'
                      : isSubscribed
                        ? 'Unsubscribe'
                        : isConsumable
                          ? 'Arm'
                          : 'Subscribe'}
                  </Button>
                )}
                <Button size="sm" variant="primary" onClick={() => fireRule(rule)} disabled={isBusy} busy={runBusy}>
                  {runBusy ? 'Running...' : 'Run now'}
                </Button>
              </Stack>
            </div>
          );
        })}
        {ruleErrors.length > 0 && (
          <p className={styles.error}>{ruleErrors.length} additional rule(s) failed to load.</p>
        )}
      </Stack>
    );
  }

  return (
    <>
      <h3 className={styles.heading}>
        <button
          className={`${styles.disclosure} ${expanded ? styles.disclosureExpanded : ''}`}
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          disabled={loading}
        >
          <span className={styles.headingText}>
            <span className={shared.sectionHeaderTitle}>Rules</span>
            <span className={`${styles.summary} ${error ? styles.summaryError : ''}`}>{summary}</span>
            {!loading && !error && rules.length > 0 && (
              <span className={subscriptionCount > 0 ? styles.summarySubscribed : styles.summaryMuted}>
                {subscriptionCount} subscribed
              </span>
            )}
          </span>
          <svg
            className={`${styles.chevron} ${expanded ? styles.chevronExpanded : ''}`}
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="m5 6 3 3 3-3" />
          </svg>
        </button>
      </h3>
      {expanded && !loading && <div className={styles.body}>{content}</div>}
    </>
  );
}
