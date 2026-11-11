'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function SuccessContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [status, setStatus] = useState('checking');
  const [review, setReview] = useState(null);
  const [tier, setTier] = useState('');

  useEffect(() => {
    if (!sessionId) {
      setStatus('error');
      return;
    }
    const accessToken = window.sessionStorage.getItem('bidcheckpro.accessToken') || '';
    if (!accessToken) {
      setStatus('same-browser');
      return;
    }

    async function load() {
      try {
        const verifyRes = await fetch('/api/verify-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, accessToken }),
        });
        const verifyJson = await verifyRes.json();
        if (!verifyRes.ok || !verifyJson.paid) {
          setStatus(verifyRes.status === 402 ? 'pending' : 'error');
          return;
        }
        setTier(verifyJson.tier || '');
        const reviewRes = await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, accessToken }),
        });
        const reviewJson = await reviewRes.json();
        if (!reviewRes.ok) {
          setStatus('error');
          return;
        }
        setReview(reviewJson);
        setStatus('ready');
      } catch {
        setStatus('error');
      }
    }

    load();
  }, [sessionId]);

  if (status === 'checking') return <div style={styles.page}>Verifying payment…</div>;
  if (status === 'pending') return <div style={styles.page}>Payment is not complete yet. Refresh this page in a moment.</div>;
  if (status === 'same-browser') {
    return (
      <div style={styles.page}>
        <h1>Payment page</h1>
        <p>Open this page in the same browser that started checkout. The review is also emailed after the webhook is delivered.</p>
        <a href="/" style={styles.btn}>Back to the bid form</a>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div style={styles.page}>
        <h1>Payment could not be verified</h1>
        <p>Use the receipt from the same browser that started checkout.</p>
        <a href="/" style={styles.btn}>Back to the bid form</a>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1>Payment confirmed</h1>
      <p>The review for this checkout is below{tier ? ` (${tier})` : ''}.</p>
      {review?.summary && <p><strong>Summary:</strong> {review.summary}</p>}
      <div style={{ textAlign: 'left' }}>
        {review?.flags?.map((flag, index) => (
          <div key={index} style={styles.flag}>
            <strong>{flag.line}</strong> — {flag.issue} ({flag.severity})
            <div>{flag.note}</div>
          </div>
        ))}
      </div>
      {review?.questions?.length > 0 && (
        <div style={{ textAlign: 'left' }}>
          <h2>Questions to ask</h2>
          <ul>{review.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>
        </div>
      )}
      <a href="/" style={styles.btn}>Back to the bid form</a>
    </div>
  );
}

export default function SuccessPage() {
  return (
    <Suspense fallback={<div style={styles.page}>Loading…</div>}>
      <SuccessContent />
    </Suspense>
  );
}

const styles = {
  page: { fontFamily: 'system-ui', maxWidth: 680, margin: '40px auto', padding: 24 },
  btn: { display: 'inline-block', background: '#111', color: '#fff', padding: '12px 20px', textDecoration: 'none', borderRadius: 4, marginTop: 16 },
  flag: { background: '#f8ece9', borderLeft: '3px solid #b42318', padding: '10px 12px', margin: '8px 0' },
};
