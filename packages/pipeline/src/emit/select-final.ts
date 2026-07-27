/**
 * Selects the delivered 50 from the qualifying pool.
 *
 * Two reasons this is a deliberate step rather than "take everything".
 *
 * First, the brief asks for 50 qualifying records, not for as many as possible.
 * Volume past 50 earns nothing and dilutes the average record.
 *
 * Second, and more important: the qualifying pool is 67% Companies House, because
 * the UK statutory register is far more productive per query than any other
 * source. Shipping the pool unchanged would produce a file that reads as one
 * registry copied at scale - which is the stated auto-fail, and would be a fair
 * reading of it, however carefully each individual record was verified.
 *
 * So a per-channel cap is applied. Records that lose their place are not
 * defective; they are surplus to a cap, and the reason is recorded.
 */
import type { FamilyOffice } from '@fo/core';

/** No single discovery channel may supply more than this share of the file. */
export const MAX_CHANNEL_SHARE = 0.4;

export interface SelectionResult {
  selected: FamilyOffice[];
  deferred: Array<{ record: FamilyOffice; reason: string }>;
  channelMix: Record<string, number>;
}

/**
 * How much a record is worth to a client, in the terms the brief uses: could a
 * fund manager act on this today?
 */
function actionability(r: FamilyOffice): number {
  const p = r.principals[0];
  let score = 0;

  if (p?.phone.value) score += 6;
  if (p?.email.value) score += 6;
  if (r.website.value) score += 3;
  if (r.street.value) score += 4;
  if (p?.fullName.value) score += 3;
  if (r.principals.filter((x) => x.fullName.value).length >= 2) score += 2;
  if (p?.controlBasis?.value) score += 3;

  score += Math.min(r.signals.length, 6);
  score += r.classification.confidence * 6;

  // Independent corroboration across channels is worth more than any single cell.
  const channels = new Set(r.discoveries.map((d) => d.channel));
  if (channels.size >= 2) score += 4;

  // Single-family offices are the stated prize; multi-family offices are already
  // in every list on the market.
  if (r.classification.type === 'single_family_office') score += 3;

  return score;
}

function primaryChannel(r: FamilyOffice): string {
  return r.discoveries[0]?.channel ?? 'unknown';
}

export function selectFinal(records: FamilyOffice[], target = 50): SelectionResult {
  const ranked = [...records].sort((a, b) => actionability(b) - actionability(a));
  const cap = Math.max(1, Math.floor(target * MAX_CHANNEL_SHARE));

  const selected: FamilyOffice[] = [];
  const deferred: Array<{ record: FamilyOffice; reason: string }> = [];
  const perChannel = new Map<string, number>();

  // First pass: fill under the cap, best records first.
  for (const r of ranked) {
    if (selected.length >= target) {
      deferred.push({ record: r, reason: 'surplus to the 50 required; lower actionability score' });
      continue;
    }
    const channel = primaryChannel(r);
    const used = perChannel.get(channel) ?? 0;
    if (used >= cap) {
      deferred.push({
        record: r,
        reason: `${channel} already supplies ${used} records (cap ${cap} of ${target}); held back to keep the file from reading as one source at scale`,
      });
      continue;
    }
    selected.push(r);
    perChannel.set(channel, used + 1);
  }

  // Second pass: if the cap left the file short, relax it rather than deliver
  // fewer than asked. A slightly concentrated file beats an incomplete one, and
  // the resulting mix is reported either way.
  if (selected.length < target) {
    for (let i = 0; i < deferred.length && selected.length < target; i++) {
      const entry = deferred[i]!;
      if (!entry.reason.startsWith('surplus')) {
        selected.push(entry.record);
        const channel = primaryChannel(entry.record);
        perChannel.set(channel, (perChannel.get(channel) ?? 0) + 1);
        deferred.splice(i, 1);
        i--;
      }
    }
  }

  return { selected, deferred, channelMix: Object.fromEntries(perChannel) };
}
