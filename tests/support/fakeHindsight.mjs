// A fake Hindsight API for the memory and backfill tests: Bearer-checked recall and retain over
// in-memory banks, plus a document read and delete and operation status / retry. A bank that was never created
// answers recall with 404; retain creates it and appends to the document (`update_mode: "append"`)
// or replaces it (otherwise, Hindsight's default); a repeated operation_id returns the original
// operation and changes nothing. `down` closes every connection unanswered.
import http from 'node:http';

export const FAKE_KEY = 'test-key';

export async function startFakeHindsight(t) {
  const banks = new Map(); // bank → {docs: Map(docId → string[] of appended contents), results: [{id,text}]}
  const seenOps = new Set();
  /** operation id → status the operations route answers (a retained operation is `completed`). */
  const opStatuses = new Map();
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
    /** Close every connection without an answer (Hindsight gone mid-request). */
    down: false,
    /** Answer every request with this HTTP status instead. */
    allStatus: null,
    /** Give an operation id a status. */
    opStatus(id, status) { opStatuses.set(id, status); },
    /** Store a document's text (e.g. a live `cc-session:` document). */
    putDoc(bank, docId, text) { if (!banks.has(bank)) h.bank(bank); banks.get(bank).docs.set(docId, [text]); },
    /** Every request whose kind is one of `kinds`. */
    of: (...kinds) => requests.filter((r) => kinds.includes(r.kind)),
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
    const d = /^\/v1\/default\/banks\/([^/]+)\/documents\/([^/]+)$/.exec(req.url);
    const o = /^\/v1\/default\/banks\/([^/]+)\/operations\/([^/]+)(\/retry)?$/.exec(req.url);
    const bank = decodeURIComponent((m ?? d ?? o)?.[1] ?? '') || null;
    const kind = m ? (m[2] ? 'recall' : 'retain') : d ? (req.method === 'DELETE' ? 'delete' : 'document') : o ? (o[3] ? 'retry' : 'operation') : 'other';
    const id = d ? decodeURIComponent(d[2]) : o ? decodeURIComponent(o[2]) : undefined;
    requests.push({ kind, bank, id, method: req.method, body, auth: req.headers.authorization });
    if (h.down) return req.socket.destroy();
    const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) return send(401, { detail: 'bad key' });
    if (h.allStatus) return send(h.allStatus, { detail: 'boom' });
    if (d && req.method === 'GET') {
      const doc = banks.get(bank)?.docs.get(id);
      return doc ? send(200, { id, bank_id: bank, original_text: doc.join('\n') }) : send(404, { detail: 'document not found' });
    }
    if (d && req.method === 'DELETE') {
      if (!banks.get(bank)?.docs.delete(id)) return send(404, { detail: 'document not found' });
      return send(200, { success: true, document_id: id, memory_units_deleted: 0, message: 'deleted' });
    }
    if (o && !o[3] && req.method === 'GET') {
      const status = opStatuses.get(id) ?? (seenOps.has(id) ? 'completed' : null);
      return status ? send(200, { operation_id: id, status }) : send(404, { detail: 'operation not found' });
    }
    if (o && o[3] && req.method === 'POST') {
      if (!opStatuses.has(id)) return send(404, { detail: 'operation not found' });
      opStatuses.set(id, 'pending');
      return send(200, { success: true, operation_id: id });
    }
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
      docs.set(item.document_id, item.update_mode === 'append' ? [...(docs.get(item.document_id) ?? []), item.content] : [item.content]);
    }
    return send(200, { success: true, async: true, operation_id: body.operation_id });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  h.url = `http://127.0.0.1:${server.address().port}`;
  return h;
}
