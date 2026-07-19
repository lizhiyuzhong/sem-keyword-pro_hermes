// Test Manus built-in Data API for search capabilities
import { readFileSync } from 'fs';

// Load env manually
const envContent = readFileSync('.env', 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

const forgeApiUrl = env.BUILT_IN_FORGE_API_URL;
const forgeApiKey = env.BUILT_IN_FORGE_API_KEY;

console.log('API URL:', forgeApiUrl ? forgeApiUrl.substring(0, 40) + '...' : 'NOT SET');
console.log('API KEY:', forgeApiKey ? 'SET' : 'NOT SET');

async function callDataApi(apiId, options = {}) {
  const baseUrl = forgeApiUrl.endsWith('/') ? forgeApiUrl : `${forgeApiUrl}/`;
  const fullUrl = new URL('webdevtoken.v1.WebDevService/CallApi', baseUrl).toString();
  const response = await fetch(fullUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      authorization: `Bearer ${forgeApiKey}`,
    },
    body: JSON.stringify({
      apiId,
      query: options.query,
      body: options.body,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  return { status: response.status, body: text.substring(0, 300) };
}

// Test various search API IDs
const apis = [
  ['Google/search', { q: 'industrial automation', num: '3' }],
  ['GoogleSearch/search', { q: 'industrial automation' }],
  ['SerpApi/search', { q: 'industrial automation', engine: 'google' }],
  ['Serper/search', { q: 'industrial automation' }],
  ['BraveSearch/search', { q: 'industrial automation' }],
  ['Bing/search', { q: 'industrial automation' }],
  ['web_search/search', { q: 'industrial automation' }],
];

for (const [apiId, query] of apis) {
  try {
    const result = await callDataApi(apiId, { query });
    console.log(`\n${result.status === 200 ? '✅' : '❌'} ${apiId} (${result.status}):`, result.body);
  } catch(e) {
    console.log(`\n❌ ${apiId}: ${e.message}`);
  }
}
