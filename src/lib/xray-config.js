const REALITY_SNI = 'www.apple.com';

const RECOMMENDED_POLICY = {
  handshake: 12,
  connIdle: 900,
  uplinkOnly: 0,
  downlinkOnly: 0,
  statsUserUplink: false,
  statsUserDownlink: false,
  bufferSize: 64,
};

const OPENAI_PROXY_DOMAINS = [
  'domain:openai.com',
  'domain:chatgpt.com',
  'domain:oaistatic.com',
  'domain:oaiusercontent.com',
];

// 客户端完整配置中强制老虎证券相关域名走海外代理
const TIGER_PROXY_DOMAINS = [
  'domain:itiger.com',
  'domain:itigerup.com',
  'domain:laohu8.com',
  'domain:tigerbbs.com',
  'domain:itigergrowtha.com',
  'domain:tigerfintech.com',
  'domain:tigerbrokers.com',
  'domain:tigerbrokers.com.sg',
  'domain:tigerbrokers.com.au',
  'domain:tigerbrokers.nz',
  'domain:tigertrade.app',
  'domain:tigeresop.com',
  'domain:tigersecurities.com',
  'domain:upfintech.com',
  'domain:tradeup.com',
  'keyword:tiger',
  'keyword:upfintech',
];

// 老虎证券 Android App 下单/行情长连接会出现 IP-only 连接，无法靠域名嗅探命中
const TIGER_PROXY_PORTS = '7000-7007,19000';

const TIGER_PROXY_IPS = [
  '39.96.129.161',
  '101.91.29.17',
  '120.25.143.214',
  '121.46.23.34',
  '124.237.224.103',
  '220.181.111.0/24',
];

// 微信/Tencent 相关域名显式直连，配合 geosite:cn 覆盖其他国内 App
const WECHAT_DIRECT_DOMAINS = [
  'domain:weixin.qq.com',
  'domain:wechat.com',
  'domain:qq.com',
  'domain:tencent.com',
  'domain:tencent-cloud.net',
  'domain:gtimg.cn',
  'domain:gtimg.com',
  'domain:qpic.cn',
  'domain:qlogo.cn',
  'domain:myqcloud.com',
  'domain:tencent-wechat.com',
  'domain:weixinbridge.com',
];

const DOMESTIC_DIRECT_DOMAINS = [
  ...WECHAT_DIRECT_DOMAINS,
  'geosite:cn',
];

const DOMESTIC_DIRECT_IPS = [
  'geoip:private',
  'geoip:cn',
];

const DOMESTIC_DNS_DIRECT_DOMAINS = [
  'domain:alidns.com',
  'domain:doh.pub',
  'domain:dot.pub',
  'domain:360.cn',
  'domain:onedns.net',
];

const DOMESTIC_DNS_DIRECT_IPS = [
  '223.5.5.5',
  '223.6.6.6',
  '2400:3200::1',
  '2400:3200:baba::1',
  '119.29.29.29',
  '1.12.12.12',
  '120.53.53.53',
  '2402:4e00::',
  '2402:4e00:1::',
  '180.76.76.76',
  '2400:da00::6666',
  '114.114.114.114',
  '114.114.115.115',
  '114.114.114.119',
  '114.114.115.119',
  '114.114.114.110',
  '114.114.115.110',
  '180.184.1.1',
  '180.184.2.2',
  '101.226.4.6',
  '218.30.118.6',
  '123.125.81.6',
  '140.207.198.6',
  '1.2.4.8',
  '210.2.4.8',
  '52.80.66.66',
  '117.50.22.22',
  '2400:7fc0:849e:200::4',
  '2404:c2c0:85d8:901::4',
  '117.50.10.10',
  '52.80.52.52',
  '2400:7fc0:849e:200::8',
  '2404:c2c0:85d8:901::8',
  '117.50.60.30',
  '52.80.60.30',
];

const CLIENT_IMPORT_NOTE = '二维码/VLESS 链接只包含节点参数；老虎证券代理、国内直连和 DNS 分流仅在复制完整配置并导入 v2rayN/v2rayNG 等支持完整 JSON 的客户端后生效。';

function createInbound({ uuid, privateKey, shortId }) {
  return {
    tag: 'vless-in',
    listen: '0.0.0.0',
    port: 443,
    protocol: 'vless',
    settings: {
      clients: [{ id: uuid, flow: 'xtls-rprx-vision' }],
      decryption: 'none',
    },
    streamSettings: {
      network: 'tcp',
      security: 'reality',
      realitySettings: {
        dest: `${REALITY_SNI}:443`,
        serverNames: [REALITY_SNI, REALITY_SNI.replace('www.', '')],
        privateKey,
        shortIds: [shortId],
      },
      sockopt: { tcpFastOpen: true, mark: 0, tcpKeepAliveInterval: 30 },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls'] },
  };
}

function createDns() {
  return {
    servers: [
      { address: 'https://8.8.8.8/dns-query', tag: 'dns-proxy' },
      { address: 'https://1.1.1.1/dns-query', tag: 'dns-proxy' },
    ],
  };
}

function createProxyOutbound(mode, ispProxy) {
  if (mode === 'direct') {
    return { tag: 'proxy', protocol: 'freedom' };
  }

  return {
    tag: 'proxy',
    protocol: 'socks',
    settings: {
      servers: [{
        address: ispProxy.address,
        port: parseInt(ispProxy.port, 10),
        users: [{ user: ispProxy.username, pass: ispProxy.password }],
      }],
    },
  };
}

function createServerConfig({ mode, uuid, privateKey, shortId, ispProxy }) {
  return {
    log: {
      loglevel: 'warning',
      access: '/var/log/xray/access.log',
      error: '/var/log/xray/error.log',
    },
    dns: createDns(),
    inbounds: [createInbound({ uuid, privateKey, shortId })],
    outbounds: [
      createProxyOutbound(mode, ispProxy),
      { tag: 'block', protocol: 'blackhole' },
      { tag: 'direct', protocol: 'freedom' },
    ],
    policy: {
      levels: { '0': RECOMMENDED_POLICY },
      system: { statsInboundUplink: false, statsInboundDownlink: false },
    },
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', inboundTag: ['dns-proxy'], outboundTag: 'proxy' },
        { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'block' },
        { type: 'field', domain: OPENAI_PROXY_DOMAINS, outboundTag: 'proxy' },
        { type: 'field', inboundTag: ['vless-in'], outboundTag: 'proxy' },
      ],
    },
  };
}

function generateClientConfig({ vpsIP, uuid, publicKey, shortId }) {
  const vlessLink = `vless://${uuid}@${vpsIP}:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${REALITY_SNI}&fp=chrome&pbk=${publicKey}&sid=${shortId}&type=tcp#VPS-Proxy-NoMUX`;

  const fullConfig = JSON.stringify({
    log: { loglevel: 'warning' },
    dns: {
      queryStrategy: 'UseIPv4',
      servers: [
        { address: '8.8.8.8', port: 53, domains: TIGER_PROXY_DOMAINS, tag: 'dns-proxy' },
        { address: '1.1.1.1', port: 53, domains: TIGER_PROXY_DOMAINS, tag: 'dns-proxy' },
        { address: '223.5.5.5', port: 53, domains: DOMESTIC_DIRECT_DOMAINS, tag: 'dns-direct' },
        { address: '119.29.29.29', port: 53, domains: DOMESTIC_DIRECT_DOMAINS, tag: 'dns-direct' },
        { address: '8.8.8.8', port: 53, domains: ['geosite:geolocation-!cn'], tag: 'dns-proxy' },
        { address: '1.1.1.1', port: 53, domains: ['geosite:geolocation-!cn'], tag: 'dns-proxy' },
        { address: '223.5.5.5', port: 53, tag: 'dns-direct' },
        { address: '119.29.29.29', port: 53, tag: 'dns-direct' },
      ],
    },
    inbounds: [
      {
        tag: 'socks',
        port: 10808,
        listen: '127.0.0.1',
        protocol: 'socks',
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
        settings: { auth: 'noauth', udp: true },
      },
      {
        tag: 'http',
        port: 10809,
        listen: '127.0.0.1',
        protocol: 'http',
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
        settings: { auth: 'noauth', udp: true },
      },
    ],
    outbounds: [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: {
          vnext: [{
            address: vpsIP,
            port: 443,
            users: [{
              id: uuid,
              alterId: 0,
              email: 't@t.tt',
              security: 'auto',
              encryption: 'none',
              flow: 'xtls-rprx-vision',
            }],
          }],
        },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            show: false,
            fingerprint: 'chrome',
            serverName: REALITY_SNI,
            publicKey,
            shortId,
            spiderX: '',
          },
          sockopt: { tcpFastOpen: true, tcpKeepAliveInterval: 30 },
        },
        mux: { enabled: false, concurrency: -1 },
      },
      { tag: 'direct', protocol: 'freedom', settings: {} },
      { tag: 'block', protocol: 'blackhole', settings: {} },
      { tag: 'dns-out', protocol: 'dns' },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      domainMatcher: 'hybrid',
      rules: [
        { type: 'field', inboundTag: ['socks', 'http'], port: '53', outboundTag: 'dns-out' },
        { type: 'field', inboundTag: ['dns-proxy'], outboundTag: 'proxy' },
        { type: 'field', inboundTag: ['dns-direct'], outboundTag: 'direct' },
        { type: 'field', outboundTag: 'proxy', domain: TIGER_PROXY_DOMAINS },
        { type: 'field', outboundTag: 'proxy', port: TIGER_PROXY_PORTS },
        { type: 'field', outboundTag: 'proxy', ip: TIGER_PROXY_IPS },
        { type: 'field', outboundTag: 'direct', domain: DOMESTIC_DIRECT_DOMAINS },
        { type: 'field', outboundTag: 'direct', ip: DOMESTIC_DIRECT_IPS },
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        { type: 'field', outboundTag: 'direct', domain: DOMESTIC_DNS_DIRECT_DOMAINS },
        { type: 'field', outboundTag: 'direct', ip: DOMESTIC_DNS_DIRECT_IPS },
        { type: 'field', port: '443', network: 'udp', outboundTag: 'block' },
        { type: 'field', outboundTag: 'proxy', domain: OPENAI_PROXY_DOMAINS },
        { type: 'field', outboundTag: 'proxy', domain: ['geosite:geolocation-!cn'] },
      ],
    },
  }, null, 2);

  return {
    vlessLink,
    fullConfig,
    clientImportNote: CLIENT_IMPORT_NOTE,
    manual: {
      address: vpsIP,
      port: 443,
      protocol: 'VLESS',
      uuid,
      flow: 'xtls-rprx-vision',
      transport: 'tcp',
      security: 'reality',
      sni: REALITY_SNI,
      publicKey,
      shortId,
      fingerprint: 'chrome',
      mux: {
        enabled: false,
        note: '关闭 MUX；Reality + Vision 开启 MUX 会导致连接失败或长连接重连',
      },
      optimizations: {
        tcpFastOpen: true,
        sockopt: { tcpKeepAliveInterval: 30 },
      },
    },
  };
}

function generateOptimizeScript() {
  const policy = JSON.stringify(JSON.stringify(RECOMMENDED_POLICY));
  const openaiDomains = JSON.stringify(JSON.stringify(OPENAI_PROXY_DOMAINS));
  const realitySni = JSON.stringify(JSON.stringify(REALITY_SNI));

  return `
python3 - <<'PY'
import json
import os
import shutil
import subprocess
import tempfile

CONFIG = '/usr/local/etc/xray/config.json'
MODES_DIR = '/usr/local/etc/xray/modes'
BACKUP_CONFIG = CONFIG + '.optimization-backup'
POLICY = json.loads(${policy})
OPENAI_PROXY_DOMAINS = json.loads(${openaiDomains})
REALITY_SNI = json.loads(${realitySni})

def ensure_rule(rules, rule):
    for existing in rules:
        if existing == rule:
            return
    rules.append(rule)

def ensure_first_rule(rules, rule):
    if rule in rules:
        rules.remove(rule)
    rules.insert(0, rule)

def migrate_dns_routing(cfg, rules):
    for server in cfg.get('dns', {}).get('servers', []):
        outbound = server.pop('outboundTag', None)
        if outbound in ('proxy', 'direct') and not server.get('tag'):
            server['tag'] = 'dns-' + outbound

    inbound_tags = {inbound.get('tag') for inbound in cfg.get('inbounds', [])}
    if {'socks', 'http'}.issubset(inbound_tags):
        legacy_dns_rule = {'type': 'field', 'port': '53', 'outboundTag': 'dns-out'}
        rules[:] = [rule for rule in rules if rule != legacy_dns_rule]
        ensure_first_rule(rules, {'type': 'field', 'inboundTag': ['dns-direct'], 'outboundTag': 'direct'})
        ensure_first_rule(rules, {'type': 'field', 'inboundTag': ['dns-proxy'], 'outboundTag': 'proxy'})
        ensure_first_rule(rules, {'type': 'field', 'inboundTag': ['socks', 'http'], 'port': '53', 'outboundTag': 'dns-out'})
    else:
        ensure_first_rule(rules, {'type': 'field', 'inboundTag': ['dns-proxy'], 'outboundTag': 'proxy'})

def write_validated_atomically(path, cfg):
    directory = os.path.dirname(path)
    fd, temp_path = tempfile.mkstemp(
        prefix='.' + os.path.basename(path) + '.', suffix='.next.json', dir=directory
    )
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(cfg, f, indent=2)
            f.write('\\n')
            f.flush()
            os.fsync(f.fileno())

        result = subprocess.run(
            ['xray', 'run', '-test', '-config', temp_path],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            raise RuntimeError(f'Xray config validation failed for {path}: {detail}')
        # mkstemp creates 0600 files for safety, but xray.service runs as the
        # "nobody" user and must be able to read the config; 0644 keeps it
        # root-writable and world-readable.
        os.chmod(temp_path, 0o644)
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)

def optimize(path):
    if not os.path.exists(path):
        return
    with open(path) as f:
        cfg = json.load(f)

    for inbound in cfg.get('inbounds', []):
        stream_settings = inbound.setdefault('streamSettings', {})
        stream_settings['sockopt'] = {
            'tcpFastOpen': True,
            'mark': 0,
            'tcpKeepAliveInterval': 30,
        }
        inbound['sniffing'] = {'enabled': True, 'destOverride': ['http', 'tls']}
        reality = stream_settings.get('realitySettings')
        if reality:
            reality['dest'] = REALITY_SNI + ':443'
            reality['serverNames'] = [REALITY_SNI, REALITY_SNI.replace('www.', '')]

    cfg['policy'] = {
        'levels': {'0': POLICY},
        'system': {'statsInboundUplink': False, 'statsInboundDownlink': False},
    }

    cfg.pop('observatory', None)

    routing = cfg.setdefault('routing', {})
    routing['domainStrategy'] = 'AsIs'
    rules = routing.setdefault('rules', [])
    migrate_dns_routing(cfg, rules)

    openai_rule = {'type': 'field', 'domain': OPENAI_PROXY_DOMAINS, 'outboundTag': 'proxy'}
    inbound_rule = {'type': 'field', 'inboundTag': ['vless-in'], 'outboundTag': 'proxy'}
    if inbound_rule in rules and openai_rule not in rules:
        rules.insert(rules.index(inbound_rule), openai_rule)
    else:
        ensure_rule(rules, openai_rule)

    write_validated_atomically(path, cfg)
    print(f'optimized: {path}')

if os.path.isfile(CONFIG):
    shutil.copy2(CONFIG, BACKUP_CONFIG)

if os.path.isdir(MODES_DIR):
    for filename in sorted(os.listdir(MODES_DIR)):
        if filename.endswith('.json'):
            optimize(os.path.join(MODES_DIR, filename))
optimize(CONFIG)
PY
`;
}

module.exports = {
  OPENAI_PROXY_DOMAINS,
  RECOMMENDED_POLICY,
  TIGER_PROXY_DOMAINS,
  TIGER_PROXY_IPS,
  TIGER_PROXY_PORTS,
  createServerConfig,
  generateClientConfig,
  generateOptimizeScript,
};
