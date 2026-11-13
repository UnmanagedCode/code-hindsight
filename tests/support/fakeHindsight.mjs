// A fake Hindsight API for the memory tests: Bearer-checked recall and retain over in-memory
// banks. A bank that was never created answers recall with 404; retain creates it and appends to
// the document; a repeated operation_id returns the original operation and appends nothing.
import http from 'node:http';

export const FAKE_KEY = 'test-key';

export async function startFakeHindsight(t) {
  const banks = new Map(); // bank → {docs: Map(docId → string[] of appended contents), results: [{id,text}]}
  const seenOps = new Set();
  const requests = [];
  const h = {
    banks,
    requests,
    /** per-bank recall latency (ms) and a status to answer retain/recall with instead */
    latency: {},
    failStatus: null,
    retainLatency: 0,
    gate: null,
    inflightRetains: 0,
    maxInflightRetains: 0,
    retainStatus: null,
    /** Hold every retain until the returned function is called. */
    hold() { let release; h.gate = new Promise((r) => { release = r; }); return () => { h.gate = null; release(); }; },
    /** Create a bank with the results its recall returns. */
    bank(name, results = []) { banks.set(name, { docs: new Map(), results }); },
    doc: (bank, docId) => banks.get(bank)?.docs.get(docId),
    retains: () => requests.filter((r) => r.kind === 'retain'),
    recalls: () => requests.filter((r) => r.kind === 'recall'),
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const m = /^\/v1\/default\/banks\/([^/]+)\/memories(\/recall)?$/.exec(req.url);
    const bank = m && decodeURIComponent(m[1]);
    const kind = m ? (m[2] ? 'recall' : 'retain') : 'other';
    requests.push({ kind, bank, body, auth: req.headers.authorization });
    const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) return send(401, { detail: 'bad key' });
    if (!m) return send(404, {});
    if (kind === 'recall') {
      if (h.latency[bank]) await new Promise((r) => setTimeout(r, h.latency[bank]));
      if (h.failStatus) return send(h.failStatus, { detail: 'boom' });
      const b = banks.get(bank);
      if (!b) return send(404, { detail: `bank ${bank} not found` });
      return send(200, { results: b.results.map((r) => ({ type: 'world', ...r })) });
    }
    if (h.gate) await h.gate;
    h.inflightRetains++;
    h.maxInflightRetains = Math.max(h.maxInflightRetains, h.inflightRetains);
    if (h.retainLatency) await new Promise((r) => setTimeout(r, h.retainLatency));
    h.inflightRetains--;
    if (h.retainStatus) return send(h.retainStatus, { detail: 'boom' });
    if (!banks.has(bank)) h.bank(bank);
    if (seenOps.has(body.operation_id)) return send(200, { success: true, operation_id: body.operation_id });
    seenOps.add(body.operation_id);
    for (const item of body.items) {
      const docs = banks.get(bank).docs;
      docs.set(item.document_id, [...(docs.get(item.document_id) ?? []), item.content]);
    }
    return send(200, { success: true, async: true, operation_id: body.operation_id });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  h.url = `http://127.0.0.1:${server.address().port}`;
  return h;
}
