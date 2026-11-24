// Magic-link email via Mailgun's HTTP API (plain fetch, no SDK), lifted from Sumi.
// With no MAILGUN_API_KEY the link is printed to the server console instead, which is what the
// local dev server and the API tests rely on -- and what production does until Joel's Mailgun
// domain verifies, so nothing here is blocked on DNS.
//
// games.acidlemon.com is the studio sending subdomain for every Acidlemon title; Cyberhell's
// From lives on it rather than on a Cyberhell-only domain. Setup checklist:
// .claude-documentation/2026-09-14-mailgun-games-acidlemon-checklist.md

export const MAIL_DOMAIN = process.env.MAILGUN_DOMAIN || 'games.acidlemon.com';
export const MAIL_FROM = process.env.MAILGUN_FROM || `Cyberhell <Cyberhell@${MAIL_DOMAIN}>`;

export async function sendMagicLink(email, link) {
  const domain = MAIL_DOMAIN;
  const apiKey = process.env.MAILGUN_API_KEY;
  if (!apiKey) {
    console.log(`[magic-link] ${email} -> ${link}`);
    return { sent: false, printed: true };
  }
  const from = MAIL_FROM;
  const text = [
    'Tap the link below to sign in to the Cyberhell editor.',
    '', link, '',
    'This link expires in 15 minutes. If you did not request it, ignore this email.',
  ].join('\n');
  const html = `
    <div style="font-family:Consolas,monospace;color:#d7d7d7;background:#0b0b0d;max-width:520px;margin:0 auto;padding:24px">
      <h2 style="color:#ff3b30;margin:0 0 12px">CYBERHELL // EDITOR</h2>
      <p>Tap to sign in:</p>
      <p><a href="${link}" style="display:inline-block;background:#ff3b30;color:#0b0b0d;
        padding:12px 22px;text-decoration:none;font-weight:bold">SIGN IN</a></p>
      <p style="font-size:13px;color:#8a8a8a">This link expires in 15 minutes.</p>
    </div>`;

  const form = new URLSearchParams({ from, to: email, subject: 'Your Cyberhell editor sign-in link', text, html });
  const base = process.env.MAILGUN_API_BASE || 'https://api.mailgun.net';
  const res = await fetch(`${base}/v3/${domain}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Mailgun send failed (${res.status}): ${detail}`);
  }
  return { sent: true };
}
