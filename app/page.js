'use client';

import { useState } from 'react';

export default function Home() {
  const [bidText, setBidText] = useState('');
  const [side, setSide] = useState('sending');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function startCheckout(tier) {
    setError('');
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, bidText, side }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error || 'Checkout failed');
      }
    } catch (e) {
      setError('Could not start checkout');
    }
  }

  async function runReview(paid = false) {
    setError('');
    setResult(null);
    if (!bidText.trim()) {
      setError('Paste a bid first.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidText, side, paid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={styles.main}>
      <div style={styles.wrap}>
        <h1 style={styles.h1}>BidCheckPro</h1>
        <p style={styles.lede}>
          Paste a bid. Get an instant review that flags soft numbers, missing items, high labor, and vague allowances.
          Built on 36 years of trades experience.
        </p>

        <div style={styles.card}>
          <label style={styles.label}>Which side of this bid are you on?</label>
          <select value={side} onChange={(e) => setSide(e.target.value)} style={styles.input}>
            <option value="sending">I'm sending this bid (find what I left off)</option>
            <option value="receiving">I received this bid (find padding before I sign)</option>
          </select>

          <label style={styles.label}>Paste the bid</label>
          <textarea
            value={bidText}
            onChange={(e) => setBidText(e.target.value)}
            placeholder="Demo & haul-off ........ 1 ls  $1,850&#10;Framing labor ........ 240 hr  $65  $15,600&#10;Cabinet install ...... 1 ls  $3,400&#10;Drywall & finish ..... 62 sh  $78  $4,836&#10;Electrical rough ..... 1 ls  $2,900&#10;Contingency .......... open"
            style={styles.textarea}
          />

          <div style={styles.actions}>
            <button onClick={() => runReview(false)} disabled={loading} style={styles.btn}>
              {loading ? 'Reviewing…' : 'Free preview'}
            </button>
            <button onClick={() => runReview(true)} disabled={loading} style={{ ...styles.btn, ...styles.btnGhost }}>
              Full review (demo unlock)
            </button>
          </div>
          {error && <p style={styles.error}>{error}</p>}
        </div>

        {result && (
          <div style={styles.result}>
            <h2>Review</h2>
            {result.preview && <p style={styles.note}>Free preview — limited flags. Paid unlocks the full report.</p>}
            <p><strong>Summary:</strong> {result.summary}</p>
            <div>
              {result.flags?.map((f, i) => (
                <div key={i} style={styles.flag}>
                  <strong>{f.line}</strong> — {f.issue} ({f.severity})
                  <div style={styles.noteText}>{f.note}</div>
                </div>
              ))}
            </div>
            {result.questions && (
              <div>
                <h3>Questions to ask</h3>
                <ul>{result.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
              </div>
            )}
          </div>
        )}

        <h2 style={{ marginTop: 40 }}>Pricing</h2>
        <div style={styles.pricing}>
          <div style={styles.plan}>
            <h3>Single bid</h3>
            <div style={styles.price}>$79</div>
            <p>One full line-by-line review</p>
            <button onClick={() => startCheckout('single')} style={styles.btn}>Check one bid</button>
          </div>
          <div style={styles.plan}>
            <h3>Compare bids</h3>
            <div style={styles.price}>$149</div>
            <p>Up to three bids side by side</p>
            <button onClick={() => startCheckout('compare')} style={styles.btn}>Compare my bids</button>
          </div>
          <div style={styles.plan}>
            <h3>Full project</h3>
            <div style={styles.price}>$359</div>
            <p>Change orders + draw schedule</p>
            <button onClick={() => startCheckout('full')} style={styles.btn}>Cover my project</button>
          </div>
        </div>
        <p style={styles.note}>
          After payment you get full access. Clean bid with nothing worth flagging = refund.
        </p>
      </div>
    </main>
  );
}

const styles = {
  main: { background: '#eceae3', minHeight: '100vh', fontFamily: 'system-ui, sans-serif', color: '#161614' },
  wrap: { maxWidth: 880, margin: '0 auto', padding: '32px 20px' },
  h1: { fontSize: '2.4rem', margin: '0 0 8px', letterSpacing: '-0.03em' },
  lede: { color: '#5c5a54', fontSize: '1.05rem', marginBottom: 24 },
  card: { background: '#f6f4ee', border: '1px solid #c9c5b8', borderRadius: 8, padding: 20, marginBottom: 24 },
  label: { display: 'block', margin: '12px 0 4px', fontWeight: 600 },
  input: { width: '100%', padding: 10, border: '1px solid #c9c5b8', borderRadius: 4, font: 'inherit', boxSizing: 'border-box' },
  textarea: { width: '100%', minHeight: 180, padding: 12, border: '1px solid #c9c5b8', borderRadius: 4, fontFamily: 'ui-monospace, monospace', fontSize: 13, boxSizing: 'border-box' },
  actions: { display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' },
  btn: { background: '#111', color: '#fff', border: 0, padding: '12px 18px', borderRadius: 4, cursor: 'pointer', fontWeight: 600 },
  btnGhost: { background: 'transparent', color: '#111', border: '1px solid #c9c5b8' },
  error: { color: '#b42318', marginTop: 8 },
  result: { background: '#f6f4ee', border: '1px solid #c9c5b8', borderRadius: 8, padding: 20, marginTop: 16 },
  flag: { background: '#f8ece9', borderLeft: '3px solid #b42318', padding: '10px 12px', margin: '8px 0' },
  noteText: { fontSize: 14, marginTop: 4 },
  note: { color: '#5c5a54', fontSize: 14 },
  pricing: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 },
  plan: { background: '#f6f4ee', border: '1px solid #c9c5b8', borderRadius: 8, padding: 16 },
  price: { fontSize: '2rem', fontWeight: 700, margin: '4px 0' },
};