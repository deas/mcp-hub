import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import actualCustomFetch, { parseNoProxy, shouldBypassProxy } from '../src/utils/proxy-fetch.js';

// Mock 'node-fetch'
vi.mock('node-fetch', () => ({
  __esModule: true,
  default: vi.fn(),
}));

// Mock 'http-proxy-agent'
const HttpProxyAgentMock = vi.fn();
vi.mock('http-proxy-agent', () => ({
  HttpProxyAgent: HttpProxyAgentMock,
}));

// Mock 'https-proxy-agent'
const HttpsProxyAgentMock = vi.fn();
vi.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: HttpsProxyAgentMock,
}));

// Unpack the default export for easier spying if it's a module wrapper
const customFetch = actualCustomFetch;
const mockedFetch = (await import('node-fetch')).default;


describe('parseNoProxy', () => {
  it('should return an empty array for empty, undefined, or null input', () => {
    expect(parseNoProxy('')).toEqual([]);
    expect(parseNoProxy(undefined)).toEqual([]);
    expect(parseNoProxy(null)).toEqual([]);
  });

  it('should parse simple hostnames', () => {
    expect(parseNoProxy('google.com,example.org')).toEqual([
      { type: 'hostname', value: 'google.com' },
      { type: 'hostname', value: 'example.org' },
    ]);
  });

  it('should parse domain wildcards', () => {
    expect(parseNoProxy('.google.com,.example.org')).toEqual([
      { type: 'domain', value: '.google.com' },
      { type: 'domain', value: '.example.org' },
    ]);
  });

  it('should parse IP addresses', () => {
    expect(parseNoProxy('192.168.1.1,10.0.0.1')).toEqual([
      { type: 'ip', value: '192.168.1.1' },
      { type: 'ip', value: '10.0.0.1' },
    ]);
  });

  it('should parse CIDR blocks', () => {
    expect(parseNoProxy('192.168.1.0/24,10.0.0.0/8')).toEqual([
      { type: 'cidr', value: '192.168.1.0/24' },
      { type: 'cidr', value: '10.0.0.0/8' },
    ]);
  });

  it('should parse a mix of types with extra spaces', () => {
    expect(parseNoProxy(' google.com, .example.org, 192.168.1.1, 10.0.0.0/8 , * ')).toEqual([
      { type: 'hostname', value: 'google.com' },
      { type: 'domain', value: '.example.org' },
      { type: 'ip', value: '192.168.1.1' },
      { type: 'cidr', value: '10.0.0.0/8' },
      { type: 'hostname', value: '*' }, // '*' is treated as a hostname by default
    ]);
  });
   it('should handle "*" as a special hostname for bypassing all', () => {
    expect(parseNoProxy('*')).toEqual([{ type: 'hostname', value: '*' }]);
  });
});

describe('shouldBypassProxy', () => {
  const rules = parseNoProxy('google.com,.example.org,192.168.1.1,10.0.0.0/8,localhost');

  it('should bypass for direct hostname match', () => {
    expect(shouldBypassProxy('http://google.com/path', rules)).toBe(true);
  });

  it('should bypass for domain match', () => {
    expect(shouldBypassProxy('http://www.example.org/path', rules)).toBe(true);
  });

  it('should bypass for sub-domain match when main domain is specified', () => {
    expect(shouldBypassProxy('http://sub.example.org/path', parseNoProxy('.example.org'))).toBe(true);
  });

  it('should bypass for exact domain match when main domain is specified', () => {
    expect(shouldBypassProxy('http://example.org/path', parseNoProxy('.example.org'))).toBe(true);
  });

  it('should not bypass for different domain', () => {
    expect(shouldBypassProxy('http://other.com/path', rules)).toBe(false);
  });

  it('should bypass for IP match', () => {
    expect(shouldBypassProxy('http://192.168.1.1/path', rules)).toBe(true);
  });

  it('should not bypass for different IP', () => {
    expect(shouldBypassProxy('http://192.168.1.2/path', rules)).toBe(false);
  });

  it('should bypass for IP in CIDR range', () => {
    expect(shouldBypassProxy('http://10.0.0.50/path', rules)).toBe(true);
  });

  it('should not bypass for IP outside CIDR range', () => {
    expect(shouldBypassProxy('http://11.0.0.1/path', rules)).toBe(false);
  });

  it('should bypass for localhost', () => {
    expect(shouldBypassProxy('http://localhost/path', rules)).toBe(true);
  });

  it('should bypass for hostname with port', () => {
    expect(shouldBypassProxy('http://google.com:8080/path', rules)).toBe(true);
  });

  it('should not bypass if no rules match', () => {
    expect(shouldBypassProxy('http://another.domain.com/path', rules)).toBe(false);
  });

  it('should not bypass with empty rules array', () => {
    expect(shouldBypassProxy('http://google.com/path', [])).toBe(false);
  });

  it('should bypass all if NO_PROXY contains "*"', () => {
    expect(shouldBypassProxy('http://anything.com/path', parseNoProxy('*'))).toBe(true);
    expect(shouldBypassProxy('http://google.com/path', parseNoProxy('specific.com,*'))).toBe(true);
  });

   it('should not bypass if hostname is an IP but rule is CIDR and IP does not match CIDR', () => {
    expect(shouldBypassProxy('http://192.168.2.50/path', parseNoProxy('192.168.1.0/24'))).toBe(false);
  });
});

describe('customFetch', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks(); // Resets mocks for fetch, HttpProxyAgent, HttpsProxyAgent
    process.env = { ...originalEnv }; // Reset environment variables
  });

  afterEach(() => {
    process.env = originalEnv; // Restore original environment variables
  });

  it('Scenario 1: No proxy env vars, should call fetch directly', async () => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;

    await customFetch('http://example.com');
    expect(mockedFetch).toHaveBeenCalledWith('http://example.com', {});
    expect(HttpProxyAgentMock).not.toHaveBeenCalled();
    expect(HttpsProxyAgentMock).not.toHaveBeenCalled();
  });

  it('Scenario 2: HTTP_PROXY set, URL is HTTP', async () => {
    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;

    const agentInstance = {}; // Mock instance
    HttpProxyAgentMock.mockReturnValue(agentInstance);

    await customFetch('http://target.com');
    expect(HttpProxyAgentMock).toHaveBeenCalledWith('http://proxy.example.com:8080');
    expect(mockedFetch).toHaveBeenCalledWith('http://target.com', { agent: agentInstance });
  });

  it('Scenario 3: HTTPS_PROXY set, URL is HTTPS', async () => {
    process.env.HTTPS_PROXY = 'https://secureproxy.example.com:8888';
    delete process.env.HTTP_PROXY;
    delete process.env.NO_PROXY;

    const agentInstance = {}; // Mock instance
    HttpsProxyAgentMock.mockReturnValue(agentInstance);

    await customFetch('https://target.com');
    expect(HttpsProxyAgentMock).toHaveBeenCalledWith('https://secureproxy.example.com:8888');
    expect(mockedFetch).toHaveBeenCalledWith('https://target.com', { agent: agentInstance });
  });

  it('Scenario 4: HTTP_PROXY set, URL matches NO_PROXY (hostname)', async () => {
    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
    process.env.NO_PROXY = 'target.com';
    delete process.env.HTTPS_PROXY;

    await customFetch('http://target.com');
    expect(mockedFetch).toHaveBeenCalledWith('http://target.com', {});
    expect(HttpProxyAgentMock).not.toHaveBeenCalled();
  });

  it('Scenario 5: HTTPS_PROXY set, URL matches NO_PROXY (domain)', async () => {
    process.env.HTTPS_PROXY = 'https://secureproxy.example.com:8888';
    process.env.NO_PROXY = '.target.com';
    delete process.env.HTTP_PROXY;

    await customFetch('https://sub.target.com');
    expect(mockedFetch).toHaveBeenCalledWith('https://sub.target.com', {});
    expect(HttpsProxyAgentMock).not.toHaveBeenCalled();
  });

  it('Scenario 6: HTTP_PROXY set, URL matches NO_PROXY (IP)', async () => {
    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
    process.env.NO_PROXY = '10.0.0.1';
    delete process.env.HTTPS_PROXY;

    await customFetch('http://10.0.0.1');
    expect(mockedFetch).toHaveBeenCalledWith('http://10.0.0.1', {});
    expect(HttpProxyAgentMock).not.toHaveBeenCalled();
  });

  it('Scenario 7: HTTPS_PROXY set, URL matches NO_PROXY (CIDR)', async () => {
    process.env.HTTPS_PROXY = 'https://secureproxy.example.com:8888';
    process.env.NO_PROXY = '10.0.0.0/8';
    delete process.env.HTTP_PROXY;

    await customFetch('https://10.0.0.5');
    expect(mockedFetch).toHaveBeenCalledWith('https://10.0.0.5', {});
    expect(HttpsProxyAgentMock).not.toHaveBeenCalled();
  });

  it('Scenario 8: HTTP_PROXY and HTTPS_PROXY set, call http URL', async () => {
    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
    process.env.HTTPS_PROXY = 'https://secureproxy.example.com:8888';
    delete process.env.NO_PROXY;

    const agentInstance = {};
    HttpProxyAgentMock.mockReturnValue(agentInstance);

    await customFetch('http://target.com');
    expect(HttpProxyAgentMock).toHaveBeenCalledWith('http://proxy.example.com:8080');
    expect(mockedFetch).toHaveBeenCalledWith('http://target.com', { agent: agentInstance });
    expect(HttpsProxyAgentMock).not.toHaveBeenCalled();
  });

  it('Scenario 9: HTTP_PROXY and HTTPS_PROXY set, call https URL', async () => {
    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
    process.env.HTTPS_PROXY = 'https://secureproxy.example.com:8888';
    delete process.env.NO_PROXY;

    const agentInstance = {};
    HttpsProxyAgentMock.mockReturnValue(agentInstance);

    await customFetch('https://target.com');
    expect(HttpsProxyAgentMock).toHaveBeenCalledWith('https://secureproxy.example.com:8888');
    expect(mockedFetch).toHaveBeenCalledWith('https://target.com', { agent: agentInstance });
    expect(HttpProxyAgentMock).not.toHaveBeenCalled();
  });

  it('Scenario 10: Only HTTP_PROXY set, call https URL (should fetch directly)', async () => {
    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;

    await customFetch('https://target.com');
    expect(mockedFetch).toHaveBeenCalledWith('https://target.com', {});
    expect(HttpProxyAgentMock).not.toHaveBeenCalled();
    expect(HttpsProxyAgentMock).not.toHaveBeenCalled();
  });

  it('Scenario 11: URL scheme not http/https (e.g. ftp)', async () => {
    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
    process.env.HTTPS_PROXY = 'https://secureproxy.example.com:8888';
    delete process.env.NO_PROXY;

    await customFetch('ftp://target.com');
    expect(mockedFetch).toHaveBeenCalledWith('ftp://target.com', {});
    expect(HttpProxyAgentMock).not.toHaveBeenCalled();
    expect(HttpsProxyAgentMock).not.toHaveBeenCalled();
  });

  it('should use case-insensitive process.env variables (http_proxy, https_proxy, no_proxy)', async () => {
    process.env.http_proxy = 'http://lowercaseproxy.example.com:8080';
    delete process.env.HTTPS_PROXY; // ensure no interference
    delete process.env.NO_PROXY;

    const agentInstance = {};
    HttpProxyAgentMock.mockReturnValue(agentInstance);

    await customFetch('http://target.com');
    expect(HttpProxyAgentMock).toHaveBeenCalledWith('http://lowercaseproxy.example.com:8080');
    expect(mockedFetch).toHaveBeenCalledWith('http://target.com', { agent: agentInstance });
  });
});
