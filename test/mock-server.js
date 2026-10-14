// Mock Sunbird gateway/Keycloak used to exercise the real JMeter engine without live traffic.
import http from 'node:http';

export function startMock() {
  const state = { requests: [], refresh: new Set(), access: new Set(), error: false, badAuth: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const respond = (value, code = 200) => {
        const body = JSON.stringify(value);
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      };
      const json = (req.headers['content-type'] || '').startsWith('application/json');
      const body = raw ? (json ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {};
      const path = req.url;
      state.requests.push({ path, method: req.method, headers: req.headers, body });
      if (req.headers.authorization !== 'Bearer mock-api-credential') return respond({ error: 'bad api key' }, 401);
      if (path.endsWith('openid-connect/token')) {
        if (state.badAuth || body.password !== 'mock-password') return respond({ error: 'invalid_grant' }, 401);
        const token = 'mock-refresh-' + state.requests.length;
        state.refresh.add(token);
        return respond({ access_token: 'mock-direct-token', refresh_token: token, expires_in: 300, refresh_expires_in: 1800 });
      }
      if (path === '/auth/v1/refresh/token') {
        if (!state.refresh.has(body.refresh_token)) return respond({ responseCode: 'UNAUTHORIZED', params: { err: 'bad refresh token' } }, 401);
        const token = 'mock-gateway-' + state.requests.length;
        state.access.add(token);
        return respond({ params: { status: 'successful' }, result: { access_token: token, expires_in: 300 } });
      }
      if (state.error) return respond({ responseCode: 'SERVER_ERROR', params: { status: 'failed', err: 'MOCK' }, result: {} });
      if (path.includes('/user/') || path.includes('/course/')) {
        if (!state.access.has(req.headers['x-authenticated-user-token'])) return respond({ responseCode: 'UNAUTHORIZED', params: { err: 'bad user token' } }, 401);
      }
      let result;
      if (/\/content\/v[12]\/read\//.test(path) || path.includes('/collection/v1/hierarchy/')) result = { content: { identifier: path.split('/').pop() } };
      else if (path === '/api/composite/v1/search') result = { content: [{ identifier: 'do_mock_content' }], count: 1 };
      else if (path.includes('/user/enrollment/list')) result = { courses: [{
        courseId: 'do_mock_course', userId: path.includes('/v1/') ? path.split('/').pop() : 'mock-user-id', batchId: 'mock-batch', status: 2, progress: 1,
        batch: { identifier: 'mock-batch', batchId: 'mock-batch', name: 'mock', enrollmentType: 'open', status: 1 },
      }] };
      else if (path.endsWith('/batch/participants/list')) {
        if (body.request?.batch?.batchId !== 'mock-batch') return respond({ responseCode: 'CLIENT_ERROR', params: { err: 'bad batchId' } }, 400);
        result = { batch: { count: 1, participants: ['mock-user-id'] } };
      }
      else if (path.includes('/user/v1/feed/')) result = { response: { userFeed: [] } };
      else if (path.includes('/user/')) result = { response: { id: path.split('/').pop() } };
      else if (path.endsWith('state/read')) {
        if (!Array.isArray(body.request.contentIds) || body.request.contentIds.length !== 2) return respond({ responseCode: 'CLIENT_ERROR', params: { err: 'bad contentIds' } }, 400);
        result = { contentList: [] };
      }
      else if (path.endsWith('state/update')) result = { [body.request.contents[0].contentId]: { response: 'SUCCESS' } };
      else if (path.endsWith('telemetry')) return respond({ responseCode: 'SUCCESS', params: {} });
      else return respond({ error: 'unknown route' }, 404);
      respond({ responseCode: 'OK', params: { status: 'successful' }, result });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, port: server.address().port, close: () => server.close() })));
}
