'use strict';

function ruleBasedReview(text, side, thorough) {
  const lines = String(text).split('\n').filter((line) => line.trim());
  const flags = [];
  lines.forEach((line) => {
    const lower = line.toLowerCase();
    if (lower.includes('contingency') || lower.includes('allowance')) {
      flags.push({
        line,
        issue: 'Open or vague',
        note: 'Put a dollar amount or clear conditions on this. Open contingencies are how budgets die.',
        severity: 'high',
      });
    }
    if (/\d+\s*hr/.test(lower)) {
      const hrs = parseInt(lower.match(/\d+/)?.[0] || 0, 10);
      if (hrs > 180) {
        flags.push({
          line,
          issue: 'High labor hours',
          note: 'Confirm what is included. Typical kitchen remodel framing is often lower unless walls are coming down.',
          severity: 'medium',
        });
      }
    }
    if (lower.includes('open') || lower.includes('tbd')) {
      flags.push({
        line,
        issue: 'Open item',
        note: 'This needs a number or clear scope before signing.',
        severity: 'high',
      });
    }
  });
  if (flags.length === 0) {
    flags.push({
      line: 'Overall',
      issue: 'No obvious soft numbers',
      note: 'Full review checks production rates, missing permits, disposal, and second coats.',
      severity: 'low',
    });
  }
  return {
    flags: thorough ? flags : flags.slice(0, 2),
    summary: thorough
      ? 'Full review complete. Check the flags and questions before you sign or send.'
      : 'Free preview. A paid review requires a completed single-bid checkout.',
    questions: [
      'Are permits and inspection fees included?',
      'What is the contingency capped at and when does it trigger?',
      'Can you break out labor hours by phase?',
    ],
    preview: !thorough,
    side: side === 'sending' ? 'sending' : 'receiving',
  };
}

module.exports = { ruleBasedReview };
