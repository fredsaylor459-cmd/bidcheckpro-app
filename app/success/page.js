export default function SuccessPage() {
  return (
    <div style={styles.page}>
      <h1>Paid checkout is turned off</h1>
      <p>Fulfillment stays disabled until the owner approves storage and launch.</p>
      <p style={styles.note}>This page does not show buyer details.</p>
      <a href="/" style={styles.btn}>Back to the bid form</a>
    </div>
  );
}

const styles = {
  page: { fontFamily: 'system-ui', maxWidth: 600, margin: '60px auto', padding: 24, textAlign: 'center' },
  btn: { display: 'inline-block', background: '#111', color: '#fff', padding: '12px 20px', textDecoration: 'none', borderRadius: 4, marginTop: 16 },
  note: { color: '#666', fontSize: 14, marginTop: 12 },
};
