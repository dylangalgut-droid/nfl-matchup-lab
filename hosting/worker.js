// The first four bytes specify the JSON range-index length. Each range contains
// one gzip-compressed public document. The owner authorizes the complete bundle.
function jsonStream(stream) {
  return new Response(stream.pipeThrough(new DecompressionStream('gzip')), {
    headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache'}
  });
}
function seedResponse(path) {
  const bytes = Uint8Array.from(atob(seed[path]), c => c.charCodeAt(0));
  return jsonStream(new Blob([bytes]).stream());
}
async function readPublished(bucket, path) {
  // HEAD and conditional range reads prevent mixing generations during a swap.
  for (let attempt = 0; attempt < 2; attempt++) {
    const header = await bucket.get('snapshot', {range:{offset:0,length:8192}});
    if (!header) return null;
    const bytes = await header.arrayBuffer();
    const size = new DataView(bytes).getUint32(0);
    if (size > 8188) throw Error('Invalid published index');
    const index = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,4,size)));
    if (!index[path]) return new Response('Week unavailable',{status:404});
    const [start,length] = index[path];
    const file = await bucket.get('snapshot', {
      onlyIf:{etagMatches:header.etag},range:{offset:4+size+start,length}
    });
    if (file?.body) return jsonStream(file.body);
  }
  return null;
}
export default {
  async fetch(req,env) {
    const path = new URL(req.url).pathname;
    if (path === '/snapshot-upload' && req.method === 'PUT') {
      const digest = req.headers.get('x-snapshot-sha256') || '';
      const signature = req.headers.get('x-update-signature') || '';
      const issued = Number(req.headers.get('x-update-time'));
      const observed = Number(req.headers.get('x-data-time'));
      if (!env.NFL_UPLOAD_KEY || !/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{64}$/.test(signature)
          || !Number.isSafeInteger(issued) || !Number.isSafeInteger(observed) || observed > issued + 60
          || Math.abs(Date.now()/1000 - issued) > 900) return new Response('Authorization required',{status:403});
      const hex = value => Uint8Array.from(value.match(/../g), pair => parseInt(pair,16));
      const key = await crypto.subtle.importKey('raw',hex(env.NFL_UPLOAD_KEY),{name:'HMAC',hash:'SHA-256'},false,['verify']);
      const message = new TextEncoder().encode([digest,issued,observed].join('\n'));
      if (!await crypto.subtle.verify('HMAC',key,hex(signature),message))
        return new Response('Invalid snapshot signature',{status:403});
      const size = Number(req.headers.get('content-length'));
      if (!(size > 4 && size <= 30000000)) return new Response('Invalid transfer size',{status:413});
      const current = await env.BUCKET.head('snapshot');
      if (observed < Number(current?.customMetadata?.observed || 0))
        return new Response('A newer snapshot is live',{status:409});
      try {
        const saved = await env.BUCKET.put('snapshot',req.body,{sha256:digest,customMetadata:{observed:String(observed)},
          onlyIf:current ? {etagMatches:current.etag} : {etagDoesNotMatch:'*'}});
        if (!saved) return new Response('Concurrent refresh; retry',{status:409});
      } catch { return new Response('Snapshot integrity or storage check failed',{status:422}); }
      return new Response('Updated',{status:200});
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method unavailable',{status:405});
    const file = assets[path === '/' ? '/index.html' : path];
    if (file) return new Response(req.method === 'HEAD' ? null : file[1],{headers:{
      'Content-Type':file[0]+'; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'
    }});
    if (path === '/data.json' || /^\/weeks\/\d{4}-\d{1,2}\.json$/.test(path)) {
      const live = await readPublished(env.BUCKET,path);
      if (live) return live;
      if (seed[path]) return seedResponse(path);
    }
    return new Response('Page unavailable',{status:404});
  }
};
