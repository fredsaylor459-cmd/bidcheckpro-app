'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildReviewEmail({ review, tier }) {
  const safeTier = tier || 'single';
  const flags = Array.isArray(review?.flags) ? review.flags : [];
  const questions = Array.isArray(review?.questions) ? review.questions : [];
  const summary = typeof review?.summary === 'string' ? review.summary : 'Review complete.';
  const flagText = flags
    .map((flag) => `- ${flag.line}: ${flag.issue}. ${flag.note}`)
    .join('\n');
  const questionText = questions.map((question) => `- ${question}`).join('\n');
  const text = [
    `Your BidCheckPro ${safeTier} review is ready.`,
    '',
    summary,
    flagText ? `\nFlags:\n${flagText}` : '',
    questionText ? `\nQuestions:\n${questionText}` : '',
  ].join('\n');
  const flagsHtml = flags.map((flag) => (
    `<div style="background:#f8ece9;border-left:3px solid #b42318;padding:10px;margin:8px 0;">
      <strong>${escapeHtml(flag.line)}</strong> — ${escapeHtml(flag.issue)} (${escapeHtml(flag.severity)})<br>
      <span style="font-size:14px;">${escapeHtml(flag.note)}</span>
    </div>`
  )).join('');
  const questionsHtml = questions.map((question) => `<li>${escapeHtml(question)}</li>`).join('');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;color:#161614;">
    <h1 style="font-size:24px;">Your BidCheckPro review</h1>
    <p>Payment confirmed for the <strong>${escapeHtml(safeTier)}</strong> tier.</p>
    <p><strong>Summary:</strong> ${escapeHtml(summary)}</p>
    ${flagsHtml ? `<h2>Flags</h2>${flagsHtml}` : ''}
    ${questionsHtml ? `<h2>Questions to ask</h2><ul>${questionsHtml}</ul>` : ''}
  </div>`;
  return {
    subject: `Your BidCheckPro review (${safeTier})`,
    text,
    html,
  };
}

module.exports = { buildReviewEmail, escapeHtml };
