'use strict';

function exactAmount(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  if (abs % 100 === 0) return `${sign}${abs / 100}`;
  return `${sign}${(abs / 100).toFixed(2)}`;
}

function parseMoneyToken(whole, fraction) {
  const dollars = Number(String(whole).replace(/,/g, ''));
  if (!Number.isFinite(dollars)) return null;
  let cents = 0;
  if (fraction) {
    const digits = String(fraction);
    cents = digits.length === 1 ? Number(digits) * 10 : Number(digits.slice(0, 2));
  }
  return dollars * 100 + cents;
}

function dollarAmounts(line) {
  const amounts = [];
  const re = /\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
  let match;
  while ((match = re.exec(line))) {
    const cents = parseMoneyToken(match[1], match[2]);
    if (cents != null) amounts.push(cents);
  }
  return amounts;
}

function bareAmount(line) {
  const match = line.match(/(?:grand\s+total|total|amount\s+due|balance\s+due|contract\s+total|contract\s+amount|subtotal)\s*[:.]?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/i);
  if (!match) return null;
  return parseMoneyToken(match[1], match[2]);
}

function isTotalLine(line) {
  return /^\s*(grand\s+total|total|amount\s+due|balance\s+due|contract\s+total|contract\s+amount)\b/i.test(line);
}

function isSubtotalLine(line) {
  return /^\s*subtotal\b/i.test(line);
}

function quantityRateMismatch(line, amounts) {
  if (amounts.length < 2) return null;
  const firstDollar = line.indexOf('$');
  if (firstDollar < 0) return null;
  const head = line.slice(0, firstDollar);
  const qtyMatch = head.match(/(\d+(?:\.\d+)?)\s*(?:hr|hrs|hours|hour|ea|each|ls|sf|sq|sh|sheets|lf|cy|ton|tons|day|days|wk|wks|week|weeks)?\s*$/i);
  if (!qtyMatch) return null;
  const qty = Number(qtyMatch[1]);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) return null;
  const rate = amounts[amounts.length - 2];
  const extension = amounts[amounts.length - 1];
  const expected = Math.round(qty * rate);
  if (expected === extension) return null;
  return { expected, actual: extension };
}

function checkBidArithmetic(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const flags = [];
  const items = [];
  let stated = null;
  let statedLine = null;
  let subtotal = null;
  let subtotalLine = null;

  lines.forEach((line) => {
    const amounts = dollarAmounts(line);
    if (isTotalLine(line)) {
      const value = amounts.length ? amounts[amounts.length - 1] : bareAmount(line);
      if (value != null) {
        stated = value;
        statedLine = line;
      }
      return;
    }
    if (isSubtotalLine(line)) {
      const value = amounts.length ? amounts[amounts.length - 1] : bareAmount(line);
      if (value != null) {
        subtotal = value;
        subtotalLine = line;
      }
      return;
    }
    if (!amounts.length) return;
    const mismatch = quantityRateMismatch(line, amounts);
    if (mismatch) {
      flags.push({
        line,
        issue: 'Line total does not match quantity times rate',
        note: `Quantity times rate is ${exactAmount(mismatch.expected)} but the line states ${exactAmount(mismatch.actual)} (${exactAmount(mismatch.expected)} vs ${exactAmount(mismatch.actual)}).`,
        severity: 'high',
      });
    }
    items.push({ line, cents: amounts[amounts.length - 1] });
  });

  const sumCents = items.length ? items.reduce((total, item) => total + item.cents, 0) : null;
  const statedCents = stated != null ? stated : subtotal;
  const statedLabel = stated != null ? statedLine : subtotalLine;
  if (statedCents != null && sumCents != null && sumCents !== statedCents) {
    flags.unshift({
      line: statedLabel,
      issue: 'Total does not match line items',
      note: `Line items add up to ${exactAmount(sumCents)} but the stated total is ${exactAmount(statedCents)} (${exactAmount(sumCents)} vs ${exactAmount(statedCents)}).`,
      severity: 'high',
    });
  }

  return {
    flags,
    sumCents,
    statedCents,
    itemCount: items.length,
  };
}

function lineLabel(line) {
  if (isTotalLine(line) || isSubtotalLine(line)) return null;
  const cut = line.split('$')[0]
    .replace(/\.+/g, ' ')
    .replace(/\d+(?:\.\d+)?/g, ' ')
    .replace(/\b(hr|hrs|hours|hour|ea|each|ls|sf|sq|sh|sheets|lf|cy|ton|tons|day|days|wk|wks|week|weeks)\b/gi, ' ');
  const label = cut.replace(/\s+/g, ' ').trim().toLowerCase();
  if (label.length < 3) return null;
  return label;
}

function labelsIn(text) {
  const found = new Set();
  String(text || '').split(/\r?\n/).forEach((line) => {
    const label = lineLabel(line.trim());
    if (label) found.add(label);
  });
  return found;
}

function compareBids(bidA, bidB) {
  const a = checkBidArithmetic(bidA);
  const b = checkBidArithmetic(bidB);
  const aValue = a.statedCents != null ? a.statedCents : a.sumCents;
  const bValue = b.statedCents != null ? b.statedCents : b.sumCents;
  const flags = [
    ...a.flags.map((flag) => ({ ...flag, line: `Bid A: ${flag.line}` })),
    ...b.flags.map((flag) => ({ ...flag, line: `Bid B: ${flag.line}` })),
  ];
  const comparison = {
    bidACents: aValue,
    bidBCents: bValue,
    bidASumCents: a.sumCents,
    bidBSumCents: b.sumCents,
    bidAStatedCents: a.statedCents,
    bidBStatedCents: b.statedCents,
    differenceCents: null,
    higher: null,
  };
  if (aValue != null && bValue != null) {
    comparison.differenceCents = Math.abs(aValue - bValue);
    comparison.higher = aValue === bValue ? 'tie' : aValue > bValue ? 'a' : 'b';
    if (aValue !== bValue) {
      const higher = comparison.higher === 'a' ? 'A' : 'B';
      flags.unshift({
        line: 'Comparison',
        issue: 'Bid totals differ',
        note: `Bid A ${exactAmount(aValue)} vs Bid B ${exactAmount(bValue)}. Bid ${higher} is higher by ${exactAmount(comparison.differenceCents)}.`,
        severity: 'high',
      });
    }
  }
  const labelsA = labelsIn(bidA);
  const labelsB = labelsIn(bidB);
  [...labelsA].filter((label) => !labelsB.has(label)).slice(0, 5).forEach((label) => {
    flags.push({
      line: `Bid A only: ${label}`,
      issue: 'Scope not in the other bid',
      note: 'This label is in bid A and not in bid B. Confirm the scope is intentional.',
      severity: 'medium',
    });
  });
  [...labelsB].filter((label) => !labelsA.has(label)).slice(0, 5).forEach((label) => {
    flags.push({
      line: `Bid B only: ${label}`,
      issue: 'Scope not in the other bid',
      note: 'This label is in bid B and not in bid A. Confirm the scope is intentional.',
      severity: 'medium',
    });
  });

  let summary = 'Compared the two bids.';
  if (aValue != null && bValue != null) {
    summary = aValue === bValue
      ? `Both bids come to ${exactAmount(aValue)}.`
      : `Bid A is ${exactAmount(aValue)} and Bid B is ${exactAmount(bValue)}.`;
  }
  return {
    flags,
    summary,
    questions: [
      'Which scope items are in one bid and missing from the other?',
      'Are allowances, permits, and disposal included in both totals?',
      'Do both bids use the same units for labor?',
    ],
    comparison,
    side: 'receiving',
  };
}

module.exports = {
  exactAmount,
  checkBidArithmetic,
  compareBids,
};
