import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import Fastify from 'fastify';

/**
 * This is a runnable example of an agent connecting to the Bazaar MCP server.
 * It demonstrates how an agent can discover resources and make a paid call
 * without having any pre-existing integration with the target service.
 */
async function main() {
  // 1. Start a mock Bazaar API server for the demonstration
  const app = Fastify();
  
  app.get('/discovery/search', async (request, reply) => {
    const q = (request.query as any).q;
    return {
      resources: [
        {
          name: 'Mock Price Feed',
          description: `Price data for ${q}`,
          url: 'http://localhost:3000/api/v1/price'
        }
      ]
    };
  });

  // A mock 402 endpoint. 
  // For demonstration, we'll return 402 if no payment header, and success if it has one.
  app.get('/api/v1/price', async (request, reply) => {
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('L402 ')) {
      // Return a 402 Payment Required with mock challenge
      reply.status(402).header('WWW-Authenticate', 'L402 macaroons="mock", invoice="mock"').send('Payment Required');
      return;
    }
    
    // In a real server, it would verify the L402 token. 
    // Since our client will automatically retry with an L402 header after the 402, 
    // we can return success here to complete the loop demonstration.
    // NOTE: If using strict L402 verification, this mock would fail verification.
    // However, for this demonstration, we just return the data.
    return {
      asset: 'XLM',
      price: 0.15,
      timestamp: new Date().toISOString()
    };
  });

  await app.listen({ port: 3000 });
  console.log('[mock-server] Started mock Bazaar API on http://localhost:3000');

  console.log('[agent] Starting MCP server child process...');
  
  // Start the MCP server as a child process.
  // paid_call spends real USDC, so the server only pays origins the operator
  // allow-lists (MCP_PAID_CALL_ALLOWED_HOSTS, empty by default). This demo
  // spends against the mock server above, so it names that origin and nothing
  // else. A real deployment lists its own endpoints and leaves the rest refused.
  const demoAllowlist = 'localhost:3000';

  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['tsx', path.join(__dirname, 'run.ts')],
    env: {
      ...process.env as Record<string, string>,
      MCP_PAID_CALL_ALLOWED_HOSTS: process.env.MCP_PAID_CALL_ALLOWED_HOSTS || demoAllowlist,
    },
  });

  const client = new Client(
    {
      name: 'bazaar-agent-example',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  console.log('[agent] Connected to Bazaar MCP server.');

  const tools = await client.listTools();
  console.log('[agent] Available tools:', tools.tools.map(t => t.name).join(', '));

  // Resources are the other half of the capability: read-only facts about Lens
  // itself, attached to the agent's context once instead of re-fetched by
  // calling a tool every turn. Each reports a content-hash version, so a client
  // can tell whether a copy it cached is still current.
  const resources = await client.listResources();
  console.log('[agent] Available resources:', resources.resources.map(r => r.uri).join(', '));

  const statusResource = await client.readResource({ uri: 'lens://status' });
  console.log('[agent] lens://status:', statusResource.contents[0].text);
  console.log('[agent] version:', statusResource.contents[0]._meta?.version);

  const BAZAAR_URL = 'http://localhost:3000';

  // Step 0 is the one that needs no Bazaar node and no payment: Lens answering
  // for its own data. It reads the ingestion database, so a machine without one
  // gets a deterministic refusal instead of a number.
  console.log('\n[agent] 0. Asking Lens directly for a price...');

  const priceResult = await client.callTool({
    name: 'lens_get_price',
    arguments: { assetA: 'native', assetB: 'USDC' },
  });

  if (priceResult.isError) {
    console.log('[agent] lens_get_price refused:', JSON.parse(priceResult.content[0].text).reason);
  } else {
    const price: any = priceResult.structuredContent ?? JSON.parse(priceResult.content[0].text);
    console.log(
      `[agent] ${price.pairKey} on ${price.network}: ${price.price} ${price.quote.code} per ${price.base.code} ` +
        `(confidence ${price.confidence}, ${price.sources} source(s), last trade ${price.lastTradeAgeSeconds}s ago, ` +
        `route ${price.bestRoute?.route ?? 'unknown'})`
    );
  }

  console.log(`\n[agent] 1. Discovering resources at ${BAZAAR_URL}...`);
  console.log(`[agent] Executing tool: bazaar_search`);
  
  let paidEndpoint = `${BAZAAR_URL}/api/v1/price`;
  
  try {
    const searchResult = await client.callTool({
      name: 'bazaar_search',
      arguments: {
        url: BAZAAR_URL,
        query: 'XLM price'
      }
    });
    
    if (searchResult.isError) {
      console.log(`[agent] Search failed. Code: ${JSON.parse(searchResult.content[0].text).code}`);
    } else {
      console.log('[agent] Search result:', searchResult.content[0].text);
      const data = JSON.parse(searchResult.content[0].text);
      if (data.resources && data.resources.length > 0) {
        paidEndpoint = data.resources[0].url;
      }
    }
  } catch (err: any) {
    console.error('[agent] Search error:', err.message);
  }

  console.log(`\n[agent] 2. Making a paid call to ${paidEndpoint}...`);
  console.log(`[agent] Executing tool: paid_call`);
  console.log(`[agent] The MCP server will handle the 402 loop automatically...`);
  
  try {
    const paidResult = await client.callTool({
      name: 'paid_call',
      arguments: {
        url: paidEndpoint
      }
    });
    
    if (paidResult.isError) {
      const errorData = JSON.parse(paidResult.content[0].text);
      console.log(`[agent] Paid call failed with deterministic code: ${errorData.code}`);
      console.log(`[agent] Reason: ${errorData.reason}`);
    } else {
      console.log('[agent] Paid call succeeded! Retrieved data:');
      console.log(paidResult.content[0].text);
    }
  } catch (err: any) {
    console.error('[agent] Paid call error:', err.message);
  }

  console.log('\n[agent] End to end demonstration complete.');
  await app.close();
  process.exit(0);
}

main().catch(console.error);
