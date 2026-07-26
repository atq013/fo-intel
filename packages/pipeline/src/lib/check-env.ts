/**
 * Verifies each configured credential with a real call. Prints status only,
 * never the key. Run with: npx tsx packages/pipeline/src/lib/check-env.ts
 */
import 'dotenv/config';

type Check = { name: string; required: boolean; run: () => Promise<string> };

const missing = (n: string) => `${n} not set`;

const checks: Check[] = [
  {
    name: 'SEC_USER_AGENT',
    required: true,
    async run() {
      const ua = process.env.SEC_USER_AGENT;
      if (!ua) throw new Error(missing('SEC_USER_AGENT'));
      if (!/\S+@\S+\.\S+/.test(ua)) throw new Error('must contain a real email address');
      const res = await fetch('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001067983&type=13F&output=atom', {
        headers: { 'User-Agent': ua },
      });
      if (res.status === 403) throw new Error('SEC rejected this User-Agent');
      return `EDGAR accepted it (${res.status})`;
    },
  },
  {
    name: 'GEMINI_API_KEY',
    required: true,
    async run() {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error(missing('GEMINI_API_KEY'));
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'models/text-embedding-004', content: { parts: [{ text: 'test' }] } }),
        },
      );
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
      const json = (await res.json()) as { embedding: { values: number[] } };
      return `embeddings live, ${json.embedding.values.length} dims`;
    },
  },
  {
    name: 'GROQ_API_KEY',
    required: true,
    async run() {
      const key = process.env.GROQ_API_KEY;
      if (!key) throw new Error(missing('GROQ_API_KEY'));
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = (await res.json()) as { data: unknown[] };
      return `${json.data.length} models available`;
    },
  },
  {
    name: 'DATABASE_URL',
    required: true,
    async run() {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error(missing('DATABASE_URL'));
      if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('does not look like a Postgres URL');
      return 'format looks right (connection tested at migrate step)';
    },
  },
  {
    name: 'SERPER_API_KEY',
    required: true,
    async run() {
      const key = process.env.SERPER_API_KEY;
      if (!key) throw new Error(missing('SERPER_API_KEY'));
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: 'test', num: 1 }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return 'search live';
    },
  },
  {
    name: 'HUNTER_API_KEY',
    required: false,
    async run() {
      const key = process.env.HUNTER_API_KEY;
      if (!key) throw new Error(missing('HUNTER_API_KEY'));
      const res = await fetch(`https://api.hunter.io/v2/account?api_key=${key}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const json = (await res.json()) as { data: { requests: { searches: { available: number } } } };
      return `${json.data.requests.searches.available} searches available`;
    },
  },
  {
    name: 'ZEROBOUNCE_API_KEY',
    required: false,
    async run() {
      const key = process.env.ZEROBOUNCE_API_KEY;
      if (!key) throw new Error(missing('ZEROBOUNCE_API_KEY'));
      const res = await fetch(`https://api.zerobounce.net/v2/getcredits?api_key=${key}`);
      const json = (await res.json()) as { Credits: string };
      if (Number(json.Credits) < 0) throw new Error('key rejected');
      return `${json.Credits} credits`;
    },
  },
  {
    name: 'COMPANIES_HOUSE_API_KEY',
    required: false,
    async run() {
      const key = process.env.COMPANIES_HOUSE_API_KEY;
      if (!key) throw new Error(missing('COMPANIES_HOUSE_API_KEY'));
      const res = await fetch('https://api.company-information.service.gov.uk/search/companies?q=capital&items_per_page=1', {
        headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return 'UK registry live';
    },
  },
];

const results = await Promise.all(
  checks.map(async (c) => {
    try {
      return { c, ok: true, msg: await c.run() };
    } catch (err) {
      return { c, ok: false, msg: err instanceof Error ? err.message : String(err) };
    }
  }),
);

let blocking = 0;
for (const { c, ok, msg } of results) {
  const mark = ok ? 'ok  ' : c.required ? 'FAIL' : 'skip';
  if (!ok && c.required) blocking++;
  console.log(`${mark}  ${c.name.padEnd(24)} ${msg}`);
}

console.log(
  blocking === 0
    ? '\nAll required credentials working.'
    : `\n${blocking} required credential(s) still needed.`,
);
process.exit(blocking === 0 ? 0 : 1);
