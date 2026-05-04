import { useCallback, useEffect, useState } from 'react';
import {
  fetchPRRuleSubscriptions,
  fetchRules,
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
  const [rules, setRules] = useState([]);
  const [subscriptions, setSubscriptions] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [busyRule, setBusyRule] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [data, subs] = await Promise.all([fetchRules(), fetchPRRuleSubscriptions(prId)]);
      setRules((data.rules || []).filter((r) => r.on === 'ci.finalized'));
      setSubscriptions(new Set(subs.map((s) => s.rule_id)));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [prId]);

  useEffect(() => {
    load();
  }, [load]);

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

  if (loading) return null;
  if (rules.length === 0) {
    return <p className={styles.empty}>No rules configured for PR triggers.</p>;
  }

  return (
    <Stack direction="col" gap={3}>
      {rules.map((rule) => {
        const isBusy = busyRule === rule.id;
        const isSubscribed = subscriptions.has(rule.id);
        const isManual = rule.manual === true;
        const requiresSubscription = rule.requires_subscription === true;
        return (
          <div key={rule.id} className={styles.row}>
            <Stack gap={2} align="center">
              <span className={styles.name}>{rule.id}</span>
              {isManual && <Badge color="gray">Manual only</Badge>}
              {requiresSubscription && isSubscribed && <Badge color="green">Subscribed</Badge>}
              {requiresSubscription && !isSubscribed && <Badge color="amber">Not subscribed</Badge>}
              {!requiresSubscription && !isManual && <Badge color="violet">Auto on all</Badge>}
            </Stack>
            <Stack gap={2}>
              {requiresSubscription && (
                <Button size="sm" onClick={() => toggleSubscription(rule)} disabled={isBusy}>
                  {isSubscribed ? 'Unsubscribe' : 'Subscribe'}
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={() => fireRule(rule)} disabled={isBusy}>
                {isBusy ? 'Running...' : 'Run now'}
              </Button>
            </Stack>
          </div>
        );
      })}
      {error && <p className={styles.error}>{error}</p>}
    </Stack>
  );
}
