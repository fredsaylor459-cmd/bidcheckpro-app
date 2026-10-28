'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

export default function SuccessPage() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [status, setStatus] = useState('checking');
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!sessionId) {
      setStatus('error');
      return;
    }

    async function verify() {
      try {
        const res = await fetch(`/api/webhook?session_id=${sessionId}`);
        const json = await res.json();
        if (json.unlocked) {
          setStatus('unlocked');
          setData(json);
        } else {
          const verifyRes = await fetch('/api/verify-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
          const verifyJson = await verifyRes.json();
          if (verifyJson.paid) {
            setStatus('unlocked');
            setData(verifyJson);
          } else {
            setStatus('pending');
          }
        }
      } catch (e) {
        setStatus('error');
      }
    }

    verify();
  }, [sessionId]);

  if (status === 'checking') return <div style={styles.page}>Verifying payment…</div>;
  if (status === 'error') return <div style={styles.page}>Something went wrong. Contact support with your receipt.</div>;
  if (status === 'pending') return <div style={styles.page}>Payment received. Full review unlocks in a moment. Refresh if needed.</div>;

  return (
    <div style={styles.page}>
      <h1>Payment confirmed</h1>
      <p>Full BidCheckPro review is unlocked for this session.</p>
      {data?.tier && <p>Tier: {data.tier}</p>}
      <p style={styles.note}>Session ID: {sessionId}</p>
      <a href="/" style={styles.btn}>Run full review</a>
      <p style={styles.note}>Paste your bid on the home page and use the full review. Access is tied to this payment.</p>
    </div>
  );
}

const styles = {
  page: { fontFamily: 'system-ui', maxWidth: 600, margin: '60px auto', padding: 24, textAlign: 'center' },
  btn: { display: 'inline-block', background: '#111', color: '#fff', padding: '12px 20px', textDecoration: 'none', borderRadius: 4, marginTop: 16 },
  note: { color: '#666', fontSize: 14, marginTop: 12 },
};