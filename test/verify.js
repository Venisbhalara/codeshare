const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { app, server } = require('../server/index');
const {
  TextOperation,
  OrderedHistoryBuffer,
  encodeHistoryIndex,
  decodeHistoryId,
  encodeRelayId,
  decodeRelayId
} = require('../shared/ot');

function httpRequest(port, options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      Object.assign({ hostname: '127.0.0.1', port }, options),
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data
          })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runVerification() {
  console.log('=== 1. Verifying Lexicographical Base62 (lexint) & Relay IDs ===');
  assert.strictEqual(encodeHistoryIndex(0), 'A0');
  assert.strictEqual(encodeHistoryIndex(1), 'A1');
  assert.strictEqual(encodeHistoryIndex(61), 'Az');
  assert.strictEqual(encodeHistoryIndex(62), 'B10');
  assert.strictEqual(decodeHistoryId('A0'), 0);
  assert.strictEqual(decodeHistoryId('Az'), 61);
  assert.strictEqual(decodeHistoryId('B10'), 62);
  assert.strictEqual(encodeRelayId('Codeshare', 'G8WoB4'), 'Q29kZXNoYXJlOkc4V29CNA==');
  assert.strictEqual(decodeRelayId('Codeshare', 'Q29kZXNoYXJlOkc4V29CNA=='), 'G8WoB4');
  console.log('✓ Lexicographical Base62 & Relay IDs verified.');

  console.log('=== 2. Verifying Operational Transformation (TextOperation) & Out-of-Order Buffer ===');
  const baseDoc = 'const x = 10;';
  const opA = new TextOperation().retain(6).delete(1).insert('count').retain(6); // "const count = 10;"
  const opB = new TextOperation().retain(10).delete(2).insert('42').retain(1);   // "const x = 42;"
  const [opAPrime, opBPrime] = TextOperation.transform(opA, opB);
  const resAB = opBPrime.apply(opA.apply(baseDoc));
  const resBA = opAPrime.apply(opB.apply(baseDoc));
  assert.strictEqual(resAB, 'const count = 42;');
  assert.strictEqual(resAB, resBA);

  const buf = new OrderedHistoryBuffer();
  buf.set(0, { node: { historyId: 'A0', value: '["a"]' } });
  buf.set(2, { node: { historyId: 'A2', value: '[1,"c"]' } }); // Out of order!
  assert.strictEqual(buf.isOutOfOrder(2), true);
  assert.strictEqual(buf.has(2), false);
  buf.set(1, { node: { historyId: 'A1', value: '[1,"b"]' } }); // Drains index 2!
  assert.strictEqual(buf.isOutOfOrder(2), false);
  assert.strictEqual(buf.has(2), true);
  console.log('✓ TextOperation diamond property & Out-of-Order Doubly-Linked Buffer verified.');

  console.log('=== 3. Starting HTTP + WebSocket Server for E2E Tests ===');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 3a. Browser Compatibility Gate
    const gateRes = await httpRequest(port, { path: '/?browserGate=1', method: 'GET' });
    assert.strictEqual(gateRes.status, 400);
    assert(gateRes.body.includes('id="use-anyway-button"'));

    const bypassRes = await httpRequest(port, {
      path: '/?browserGate=1',
      method: 'GET',
      headers: { Cookie: 'forceBrowserCompatibility=true' }
    });
    assert.strictEqual(bypassRes.status, 200);
    console.log('✓ Browser Compatibility Gate (HTTP 400 + forceBrowserCompatibility cookie) verified.');

    // 3b. Anonymous Session Creation & /new -> 302 Redirect
    const newRes = await httpRequest(port, { path: '/new', method: 'GET' });
    assert.strictEqual(newRes.status, 302);
    const setCookies = newRes.headers['set-cookie'] || [];
    assert(setCookies.some((c) => c.startsWith('web.sid=')));
    assert(setCookies.some((c) => c.startsWith('web.sid.sig=')));
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
    const roomPath = newRes.headers.location;
    const shortId = roomPath.slice(1);
    assert(/^[a-zA-Z0-9]{6}$/.test(shortId));
    console.log(`✓ Anonymous Session (web.sid + web.sid.sig) & /new -> 302 Redirect (/${shortId}) verified.`);

    // 3c. Real-Time WebSocket GraphQL Collaboration (`codeshare-graphql-ws`)
    const wsA = new WebSocket(`ws://127.0.0.1:${port}/-/api/graphql`, 'codeshare-graphql-ws', {
      headers: { Cookie: cookieHeader }
    });
    const wsB = new WebSocket(`ws://127.0.0.1:${port}/-/api/graphql`, 'codeshare-graphql-ws');

    await Promise.all([
      new Promise((res) => wsA.once('open', res)),
      new Promise((res) => wsB.once('open', res))
    ]);

    wsA.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    wsB.send(JSON.stringify({ type: 'connection_init', payload: {} }));

    // Subscribe Client B to `codeHistoryCreations` in the new room
    const receivedByB = new Promise((resolve) => {
      wsB.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (
          msg.type === 'data' &&
          msg.id === 'sub-history-1' &&
          msg.payload &&
          msg.payload.data &&
          msg.payload.data.codeHistoryCreations
        ) {
          resolve(msg.payload.data.codeHistoryCreations.newCodeHistoryEdge);
        }
      });
    });

    wsB.send(
      JSON.stringify({
        type: 'start',
        id: 'sub-history-1',
        payload: {
          operationName: 'CodeshareFirepad_onCodeHistoryCreations_Subscription',
          query: 'subscription { codeHistoryCreations }',
          variables: { input: { codeshareId: encodeRelayId('Codeshare', shortId) } }
        }
      })
    );

    await new Promise((r) => setTimeout(r, 50));

    // Client A sends an OT operation at "A0" over WebSocket
    const opA0 = new TextOperation().insert('console.log("Hello Codeshare!");');
    wsA.send(
      JSON.stringify({
        type: 'start',
        id: 'mut-1',
        payload: {
          operationName: 'CodeshareFirepad_createCodeHistory_Mutation',
          query: 'mutation { createCodeHistory }',
          variables: {
            input: {
              codeshareId: encodeRelayId('Codeshare', shortId),
              historyId: 'A0',
              value: JSON.stringify(opA0.toJSON()),
              clientId: 'test-client-A'
            }
          }
        }
      })
    );

    const broadcastedEdge = await receivedByB;
    assert.strictEqual(broadcastedEdge.node.historyId, 'A0');
    assert.strictEqual(
      JSON.parse(broadcastedEdge.node.value)[0],
      'console.log("Hello Codeshare!");'
    );
    console.log('✓ Real-time WebSocket OT mutation & subscription broadcast verified.');

    // 3d. Verify CodeeFlow Branding, Custom SVG Logo & Home Page "Join Existing" (/join?room=...)
    const homeRes = await httpRequest(port, { path: '/', method: 'GET' });
    assert.strictEqual(homeRes.status, 200);
    assert(homeRes.body.includes('Codee<span class="brand-name-accent">Flow</span>'));
    assert(homeRes.body.includes('class="brand-logo-svg"'));
    assert(homeRes.body.includes('codeeflow.io /'));

    const logoRes = await httpRequest(port, { path: '/shared/logo.svg', method: 'GET' });
    assert.strictEqual(logoRes.status, 200);
    assert(logoRes.body.includes('<svg'));

    const loginRes = await httpRequest(port, { path: '/login', method: 'GET' });
    assert.strictEqual(loginRes.status, 200);
    assert(!loginRes.body.includes('demo@codeflow.io'));
    assert(!loginRes.body.includes('Password123!'));
    assert(loginRes.body.includes('autocomplete="current-password"'));

    const registerRes = await httpRequest(port, { path: '/register', method: 'GET' });
    assert.strictEqual(registerRes.status, 200);
    assert(!registerRes.body.includes('Grace Hopper'));
    assert(registerRes.body.includes('autocomplete="new-password"'));

    const joinRes = await httpRequest(port, {
      path: `/join?room=${encodeURIComponent(`http://localhost:3000/${shortId}`)}`,
      method: 'GET'
    });
    assert.strictEqual(joinRes.status, 302);
    assert.strictEqual(joinRes.headers.location, `/${shortId}`);

    const joinLineRangeRes = await httpRequest(port, {
      path: `/join?room=${encodeURIComponent(`http://localhost:3000/${shortId}#L10-L22`)}`,
      method: 'GET'
    });
    assert.strictEqual(joinLineRangeRes.status, 302);
    assert.strictEqual(joinLineRangeRes.headers.location, `/${shortId}#L10-L22`);

    const appJsRes = await httpRequest(port, { path: '/-/js/app.js', method: 'GET' });
    assert.strictEqual(appJsRes.status, 200);
    assert(appJsRes.body.includes('parsePermalinkHash'));
    assert(appJsRes.body.includes('formatPermalinkHash'));
    assert(appJsRes.body.includes('triggerCopyCode'));

    const customTitle = `Studio Session ${shortId}`;
    const expectedSlug = `Studio-Session-${shortId}`;
    const gqlRenameBody = JSON.stringify({
      operationName: 'updateCodeshareMutation',
      query: 'mutation updateCodeshareMutation($input: UpdateCodeshareInput!) { updateCodeshare(input: $input) { codeshare { id slug title } } }',
      variables: {
        input: {
          id: encodeRelayId('Codeshare', shortId),
          title: customTitle
        }
      }
    });
    const renameRes = await httpRequest(
      port,
      {
        path: '/-/api/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader
        }
      },
      gqlRenameBody
    );
    assert.strictEqual(renameRes.status, 200);
    const renameJson = JSON.parse(renameRes.body);
    assert.strictEqual(renameJson.data.updateCodeshare.codeshare.slug, expectedSlug);
    assert.strictEqual(renameJson.data.updateCodeshare.codeshare.title, customTitle);

    const slugRoomRes = await httpRequest(port, {
      path: `/${expectedSlug}`,
      method: 'GET',
      headers: { Cookie: cookieHeader }
    });
    assert.strictEqual(slugRoomRes.status, 200);
    assert(slugRoomRes.body.includes(customTitle));
    assert(slugRoomRes.body.includes(`"shortId":"${shortId}"`));
    assert(slugRoomRes.body.includes('id="codeshare-copy-button"'));
    assert(slugRoomRes.body.includes('id="permalink-banner"'));
    assert(slugRoomRes.body.includes('id="permalink-copy-url-btn"'));
    assert(slugRoomRes.body.includes('id="permalink-copy-lines-btn"'));
    assert(slugRoomRes.body.includes('id="status-permalink-btn"'));
    console.log('✓ One-Click Copy Code & Smart Line-Range Permalinks (#L10-L22) verified.');

    // Verify URL -> Title Sync (changing URL in browser address bar updates room Title)
    const urlDrivenSlug = `Url-Driven-Title-${shortId}`;
    const urlSyncRes = await httpRequest(port, {
      path: `/${urlDrivenSlug}`,
      method: 'GET',
      headers: { Cookie: cookieHeader }
    });
    assert.strictEqual(urlSyncRes.status, 200);
    assert(urlSyncRes.body.includes(`"shortId":"${shortId}"`));
    assert(urlSyncRes.body.includes(`"title":"${urlDrivenSlug}"`));
    console.log(`✓ Two-way Title <-> URL Sync (/${expectedSlug} & /${urlDrivenSlug} -> room ${shortId}) verified.`);

    wsA.close();
    wsB.close();
  } finally {
    server.close();
  }
  console.log('=== ALL VERIFICATION TESTS PASSED ===');
  process.exit(0);
}

runVerification().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
