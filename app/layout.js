export const metadata = {
  title: 'BidCheckPro — Automated Bid Review',
  description: 'Paste a bid. Get an instant AI review that flags soft numbers, missing items, and high labor. Built on 36 years of trades experience.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}