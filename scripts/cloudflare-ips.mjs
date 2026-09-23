#!/usr/bin/env node
/**
 * Regenerates `deploy/cloudflare-ips.caddy` from Cloudflare's own published list.
 *
 * WHY THIS IS A SCRIPT AND NOT A LIST SOMEBODY TYPED. Caddy has to be told which
 * peers are allowed to speak for a client, or `X-Forwarded-For` is whatever the
 * client felt like sending and the rate limiter is limiting a header. Cloudflare
 * publishes the ranges and changes them — rarely, but it does — so the choice is
 * between a list that is checked against the source and a list that is correct
 * on the day it was pasted and silently wrong afterwards.
 *
 * Caddy 2.8 can do this at runtime with the `caddy-cloudflare-ip` module, but
 * that needs a custom binary built with xcaddy, which is a whole build pipeline
 * to avoid running one command after a Cloudflare announcement. This is the
 * smaller thing that is honest about what it is: the generated file carries the
 * date and the source, and `npm run cloudflare-ips -- --check` fails if the
 * committed file no longer matches Cloudflare.
 *
 *   node scripts/cloudflare-ips.mjs           rewrite the file
 *   node scripts/cloudflare-ips.mjs --check   exit 1 if it is out of date
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCES = ['https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6'];
const TARGET = resolve('deploy/cloudflare-ips.caddy');

const fetchRanges = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const ranges = (await response.text())
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (ranges.length === 0) throw new Error(`${url} returned nothing`);
  return ranges;
};

/** Everything but the date line, which is the only part allowed to drift. */
const body = (ranges) => `#
# The peers Caddy will believe about who the client is.
#
# Imported from deploy/Caddyfile into the global \`servers\` block. On the VPS it
# is installed beside it, at /etc/caddy/cloudflare-ips.caddy, because \`import\`
# resolves relative to the file doing the importing.
#
# GENERATED — do not edit by hand. \`npm run cloudflare-ips\` rewrites it from
# ${SOURCES.join(' and ')}.
#
# trusted_proxies:    a connection from one of these is Cloudflare, so the
#                     client-identifying header it sends may be believed.
#                     Anything else is a stranger and its headers are ignored.
# client_ip_headers:  Cloudflare puts the real client in CF-Connecting-IP. Read
#                     from a TRUSTED peer only — that is what makes it a fact
#                     rather than a claim.
trusted_proxies static${ranges.map((range) => ` \\\n\t${range}`).join('')}
client_ip_headers CF-Connecting-IP
`;

const main = async () => {
  const ranges = (await Promise.all(SOURCES.map(fetchRanges))).flat();
  const generated = `# Cloudflare edge IP ranges, fetched ${new Date().toISOString().slice(0, 10)}.\n${body(ranges)}`;

  if (process.argv.includes('--check')) {
    const current = readFileSync(TARGET, 'utf8');
    // The date line is metadata; the ranges are the contract.
    const strip = (text) => text.split('\n').slice(1).join('\n');
    if (strip(current) !== strip(generated)) {
      console.error(
        'deploy/cloudflare-ips.caddy no longer matches Cloudflare. Run `npm run cloudflare-ips`,\n' +
          'commit the result, and copy it to /etc/caddy/cloudflare-ips.caddy on the VPS.',
      );
      process.exit(1);
    }
    console.log(`deploy/cloudflare-ips.caddy matches Cloudflare (${ranges.length} ranges).`);
    return;
  }

  writeFileSync(TARGET, generated);
  console.log(`Wrote ${TARGET} — ${ranges.length} ranges.`);
};

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
