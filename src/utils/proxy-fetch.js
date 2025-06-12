import fetch from 'node-fetch';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { URL } from 'url';

// Simple IP regex (does not validate all cases but good for common ones)
const IP_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// Simple CIDR regex (does not validate all cases but good for common ones)
const CIDR_REGEX = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet, index, arr) => {
    return acc + parseInt(octet, 10) * Math.pow(256, (arr.length - 1 - index));
  }, 0);
}

function isIpInCidr(ip, cidr) {
  const cidrMatch = cidr.match(CIDR_REGEX);
  if (!cidrMatch) return false;

  const cidrIp = cidrMatch[1];
  const prefixLength = parseInt(cidrMatch[2], 10);

  if (prefixLength < 0 || prefixLength > 32) return false; // Invalid prefix length

  const ipLong = ipToLong(ip);
  const cidrIpLong = ipToLong(cidrIp);

  // Create a mask based on the prefix length
  // For /24, mask is 0xFFFFFF00. For /16, 0xFFFF0000 etc.
  const mask = (0xFFFFFFFF << (32 - prefixLength)) >>> 0; // Ensure unsigned integer

  return (ipLong & mask) === (cidrIpLong & mask);
}

export function parseNoProxy(noProxyVar) {
  if (!noProxyVar) {
    return [];
  }
  return noProxyVar.split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
    .map(part => {
      if (part.startsWith('.')) {
        return { type: 'domain', value: part };
      } else if (IP_REGEX.test(part)) {
        return { type: 'ip', value: part };
      } else if (CIDR_REGEX.test(part)) {
        return { type: 'cidr', value: part };
      } else {
        // Default to hostname if no other pattern matches
        return { type: 'hostname', value: part };
      }
    });
}

export function shouldBypassProxy(urlString, noProxyRules) {
  if (!noProxyRules || noProxyRules.length === 0) {
    return false;
  }
  let hostname;
  try {
    const url = new URL(urlString);
    hostname = url.hostname;
  } catch (e) {
    // If URL is invalid, we can't determine hostname, so don't bypass
    return false;
  }

  // Support for bypassing all for '*'
  if (noProxyRules.some(rule => rule.value === '*')) {
      return true;
  }

  for (const rule of noProxyRules) {
    switch (rule.type) {
      case 'hostname':
        if (hostname === rule.value) {
          return true;
        }
        break;
      case 'domain':
        // Ensure rule.value starts with a dot for domain matching, e.g. ".example.com"
        // Hostname "example.com" should match ".example.com"
        // Hostname "www.example.com" should match ".example.com"
        if (hostname.endsWith(rule.value) || hostname === rule.value.substring(1)) {
          return true;
        }
        break;
      case 'ip':
        if (hostname === rule.value) {
          return true;
        }
        break;
      case 'cidr':
        // Only try to match if the hostname looks like an IP
        if (IP_REGEX.test(hostname) && isIpInCidr(hostname, rule.value)) {
          return true;
        }
        break;
    }
  }
  return false;
}

async function customFetch(url, options = {}) {
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;

  const noProxyRules = parseNoProxy(noProxy);
  const bypass = shouldBypassProxy(url, noProxyRules);

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    // If URL is invalid, fetch will likely throw an error anyway.
    // Or handle as an error specific to proxy logic if preferred.
    return fetch(url, options);
  }

  const isHttp = parsedUrl.protocol === 'http:';
  const isHttps = parsedUrl.protocol === 'https:';

  if (bypass) {
    return fetch(url, options);
  }

  let agent = null;
  if (isHttp && httpProxy) {
    agent = new HttpProxyAgent(httpProxy);
  } else if (isHttps && httpsProxy) {
    agent = new HttpsProxyAgent(httpsProxy);
  }
  // If no specific proxy for the protocol, or no proxy at all, fetch directly (or agent is null)

  if (agent) {
    return fetch(url, { ...options, agent });
  } else {
    return fetch(url, options);
  }
}

export default customFetch;
