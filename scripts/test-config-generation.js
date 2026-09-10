const assert = require('assert');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const {
  createServerConfig,
  generateClientConfig,
  generateOptimizeScript,
  RECOMMENDED_POLICY,
  TIGER_PROXY_DOMAINS,
  TIGER_PROXY_IPS,
  TIGER_PROXY_PORTS,
} = require('../src/lib/xray-config');

const sample = {
  vpsIP: '203.0.113.10',
  uuid: '11111111-1111-4111-8111-111111111111',
  privateKey: 'sample-private-key',
  publicKey: 'sample-public-key',
  shortId: '0123456789abcdef',
  ispProxy: {
    address: 'proxy.example.test',
    port: '12345',
    username: 'user',
    password: 'pass',
  },
};

function loadConfigManagerForHome(homeDir) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'config.js'), 'utf8');
  const module = { exports: {} };

  vm.runInNewContext(source, {
    require(request) {
      if (request === 'fs') return fs;
      if (request === 'path') return path;
      if (request === 'os') return { homedir: () => homeDir };
      throw new Error(`Unexpected dependency: ${request}`);
    },
    module,
    exports: module.exports,
    Buffer,
  }, { filename: 'config.js' });

  return module.exports.ConfigManager;
}

function createFakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^protected:/, ''),
  };
}

function testConfigIsEncryptedAndUsesPrivatePermissions() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novabit-config-secure-'));
  try {
    const ConfigManager = loadConfigManagerForHome(homeDir);
    const manager = new ConfigManager({ safeStorage: createFakeSafeStorage() });
    const config = {
      vps: { host: 'server.example.test', port: '22', username: 'root', password: 'vps-secret', privateKey: '' },
      ispProxy: { address: 'proxy.example.test', port: '12345', username: 'proxy-user', password: 'proxy-secret' },
      deploy: { uuid: sample.uuid, privateKey: 'reality-secret', publicKey: sample.publicKey, shortId: sample.shortId, vpsIP: sample.vpsIP, deployed: true },
    };

    const saved = manager.save(config);
    assert.strictEqual(saved.success, true);

    const configDir = path.join(homeDir, '.vps-proxy-manager');
    const configFile = path.join(configDir, 'config.json');
    const raw = fs.readFileSync(configFile, 'utf8');
    const stored = JSON.parse(raw);

    assert.strictEqual(stored.storageVersion, 2);
    assert.strictEqual(typeof stored.encryptedConfig, 'string');
    assert.doesNotMatch(raw, /vps-secret|proxy-secret|reality-secret/);
    assert.strictEqual(fs.statSync(configDir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(configFile).mode & 0o777, 0o600);

    const loaded = new ConfigManager({ safeStorage: createFakeSafeStorage() }).load();
    assert.strictEqual(loaded.success, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(loaded.data)), config);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function testLegacyPlaintextConfigMigratesToEncryptedGenericProxyKey() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novabit-config-migrate-'));
  try {
    const configDir = path.join(homeDir, '.vps-proxy-manager');
    const configFile = path.join(configDir, 'config.json');
    const legacyProxyKey = ['ipro', 'yal'].join('');
    const legacyConfig = {
      vps: { host: 'server.example.test', port: '22', username: 'root', password: 'legacy-secret', privateKey: '' },
      [legacyProxyKey]: { address: 'proxy.example.test', port: '12345', username: 'proxy-user', password: 'legacy-proxy-secret' },
      deploy: { uuid: '', privateKey: '', publicKey: '', shortId: '', vpsIP: '', deployed: false },
    };
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(legacyConfig), 'utf8');

    const ConfigManager = loadConfigManagerForHome(homeDir);
    const loaded = new ConfigManager({ safeStorage: createFakeSafeStorage() }).load();

    assert.strictEqual(loaded.success, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(loaded.data.ispProxy)), legacyConfig[legacyProxyKey]);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(loaded.data, legacyProxyKey), false);
    const migratedRaw = fs.readFileSync(configFile, 'utf8');
    assert.doesNotMatch(migratedRaw, /legacy-secret|legacy-proxy-secret/);
    assert.strictEqual(JSON.parse(migratedRaw).storageVersion, 2);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function testEncryptedConfigPreservesOtherCredentialShapedSettings() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novabit-config-preserve-'));
  try {
    const ConfigManager = loadConfigManagerForHome(homeDir);
    const manager = new ConfigManager({ safeStorage: createFakeSafeStorage() });
    const config = {
      vps: { host: '', port: '22', username: 'root', password: '', privateKey: '' },
      ispProxy: { address: 'proxy.example.test', port: '12345', username: 'proxy-user', password: 'proxy-secret' },
      futureService: { address: 'future.example.test', port: '443', username: 'future-user', password: 'future-secret' },
      deploy: { uuid: '', privateKey: '', publicKey: '', shortId: '', vpsIP: '', deployed: false },
    };

    assert.strictEqual(manager.save(config).success, true);
    const loaded = new ConfigManager({ safeStorage: createFakeSafeStorage() }).load();
    assert.strictEqual(loaded.success, true);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(loaded.data.futureService)),
      config.futureService,
      'normalization must not delete unrelated settings that happen to contain credentials'
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function testLegacyPlaintextPermissionsTightenEvenWhenEncryptionIsUnavailable() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novabit-config-permissions-'));
  try {
    const configDir = path.join(homeDir, '.vps-proxy-manager');
    const configFile = path.join(configDir, 'config.json');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(configFile, JSON.stringify({ password: 'legacy-secret' }), { mode: 0o644 });

    const ConfigManager = loadConfigManagerForHome(homeDir);
    const loaded = new ConfigManager({
      safeStorage: { isEncryptionAvailable: () => false },
    }).load();

    assert.strictEqual(loaded.success, false);
    assert.strictEqual(fs.statSync(configDir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(configFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function testRepositorySourceUsesGenericIspProxyNaming() {
  const providerSpecificName = new RegExp(['ipro', 'yal'].join(''), 'i');
  const sourceFiles = [
    'main.js',
    'preload.js',
    'src/renderer.js',
    'src/lib/config.js',
    'src/lib/xray-config.js',
    'src/components/settings.js',
    'src/components/deploy.js',
    'src/components/dashboard.js',
    'src/index.html',
  ];

  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, providerSpecificName, `${file} should use provider-neutral ISP proxy naming`);
  }
}

function getProxyOutbound(config) {
  return config.outbounds.find((outbound) => outbound.tag === 'proxy');
}

function testClientMuxDisabled() {
  const generated = generateClientConfig(sample);
  const fullConfig = JSON.parse(generated.fullConfig);
  const proxy = getProxyOutbound(fullConfig);

  assert.strictEqual(proxy.protocol, 'vless');
  assert.deepStrictEqual(proxy.mux, { enabled: false, concurrency: -1 });
  assert.strictEqual(generated.manual.mux.enabled, false);
  assert.match(generated.manual.mux.note, /关闭/);
}

function testServerPolicyForLongLivedConnections() {
  const ispProxyConfig = createServerConfig({
    mode: 'proxy',
    uuid: sample.uuid,
    privateKey: sample.privateKey,
    shortId: sample.shortId,
    ispProxy: sample.ispProxy,
  });

  assert.deepStrictEqual(ispProxyConfig.policy.levels['0'], RECOMMENDED_POLICY);
  assert.strictEqual(ispProxyConfig.observatory, undefined);
  assert.deepStrictEqual(
    ispProxyConfig.inbounds[0].streamSettings.sockopt,
    { tcpFastOpen: true, mark: 0, tcpKeepAliveInterval: 30 }
  );
  assert.strictEqual(RECOMMENDED_POLICY.bufferSize, 64, 'conservative buffer avoids high per-request memory pressure');
  assert.strictEqual(RECOMMENDED_POLICY.uplinkOnly, 0, 'half-closed HTTP connections should not be retained unnecessarily');
  assert.strictEqual(RECOMMENDED_POLICY.downlinkOnly, 0, 'half-closed HTTP connections should not be retained unnecessarily');
}

function testOptimizeScriptUsesPythonJsonParsing() {
  const script = generateOptimizeScript();

  assert.match(script, /json\.loads/);
  assert.match(script, /CONFIG = '\/usr\/local\/etc\/xray\/config\.json'/);
  assert.match(script, /MODES_DIR = '\/usr\/local\/etc\/xray\/modes'/);
  assert.doesNotMatch(script, /POLICY = \\{[^\\n]*false/);
  assert.match(script, /tempfile\.mkstemp/);
  assert.match(script, /xray', 'run', '-test', '-config', temp_path/);
  assert.match(script, /os\.replace\(temp_path, path\)/);
  assert.match(
    script,
    /os\.chmod\(temp_path, 0o644\)/,
    'mkstemp creates 0600 files but xray.service runs as nobody and must be able to read the config'
  );
  assert.match(script, /optimization-backup/);
}

function testOptimizeScriptValidatesTempConfigAsJson() {
  const script = generateOptimizeScript();

  assert.match(
    script,
    /prefix='\.' \+ os\.path\.basename\(path\) \+ '\.', suffix='\.next\.json', dir=directory/,
    'Xray determines the config format from the temporary file extension, so the validation file must end in .json'
  );
}

function testOptimizeRollbackReportsFailure() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const restartCommand = source.slice(
    source.indexOf('function createOptimizeRestartCommand()'),
    source.indexOf('function createKernelNetworkTuningCommand()')
  );

  assert.ok(restartCommand.length > 0, 'createOptimizeRestartCommand should exist');
  // 注释里会引用历史上的错误写法，断言只看真正执行的 shell 代码。
  const shellCode = restartCommand
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  assert.doesNotMatch(
    shellCode,
    /!\s*sleep\s+\d+/,
    'sleep must never appear in a negated condition: its exit code is always 0, so `! sleep` is always true'
  );
  assert.match(shellCode, /sleep 3/, 'startup wait should allow for slow boots');
  assert.match(
    shellCode,
    /chmod 644 "\$ACTIVE_CONFIG"/,
    'cp keeps the target permissions, so the rollback must reset them or a corrupted 0600 config stays unreadable for nobody'
  );
  assert.match(
    shellCode,
    /本次优化未生效[\s\S]*?exit 1/,
    'a successful rollback must still exit non-zero, otherwise the UI reports success for an optimization that was reverted'
  );
}

function testOptimizeScriptMigratesLegacyDnsRouting() {
  const script = generateOptimizeScript();

  assert.match(script, /server\.pop\('outboundTag', None\)/);
  assert.match(script, /server\['tag'\] = 'dns-' \+ outbound/);
  assert.match(script, /inboundTag': \['socks', 'http'\], 'port': '53', 'outboundTag': 'dns-out'/);
  assert.match(script, /inboundTag': \['dns-proxy'\], 'outboundTag': 'proxy'/);
  assert.match(script, /inboundTag': \['dns-direct'\], 'outboundTag': 'direct'/);
}

function testOptimizeScriptEncodesRealitySniForPythonJson() {
  const script = generateOptimizeScript();
  const assignments = script.split('\n').filter((line) => (
    line.startsWith('POLICY = ') ||
    line.startsWith('OPENAI_PROXY_DOMAINS = ') ||
    line.startsWith('REALITY_SNI = ')
  ));

  assert.strictEqual(assignments.length, 3, 'optimizer should initialize all JSON-backed constants');
  execFileSync('python3', ['-c', `import json\n${assignments.join('\n')}`], { encoding: 'utf8' });
}

function testRealitySniChanged() {
  const ispProxyConfig = createServerConfig({
    mode: 'proxy',
    uuid: sample.uuid,
    privateKey: sample.privateKey,
    shortId: sample.shortId,
    ispProxy: sample.ispProxy,
  });

  const reality = ispProxyConfig.inbounds[0].streamSettings.realitySettings;
  assert.strictEqual(reality.dest, 'www.apple.com:443');
  assert.deepStrictEqual(reality.serverNames, ['www.apple.com', 'apple.com']);

  const generated = generateClientConfig(sample);
  const fullConfig = JSON.parse(generated.fullConfig);
  const proxy = getProxyOutbound(fullConfig);
  assert.strictEqual(proxy.streamSettings.realitySettings.serverName, 'www.apple.com');
  assert.match(generated.vlessLink, /sni=www\.apple\.com/);
  assert.strictEqual(generated.manual.sni, 'www.apple.com');
}

function testPackageLockVersionMatchesPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));

  assert.strictEqual(packageLock.version, packageJson.version);
  assert.strictEqual(packageLock.packages[''].version, packageJson.version);
}

function testClientImportNoteExplainsRoutingRequiresFullConfig() {
  const generated = generateClientConfig(sample);

  assert.match(generated.clientImportNote, /完整配置/);
  assert.match(generated.clientImportNote, /老虎证券代理/);
  assert.match(generated.clientImportNote, /国内直连/);
  assert.match(generated.clientImportNote, /DNS 分流/);
  assert.match(generated.clientImportNote, /二维码|VLESS/);
}

function testClientFullConfigRoutesDnsThroughDnsOutbound() {
  const generated = generateClientConfig(sample);
  const fullConfig = JSON.parse(generated.fullConfig);
  const dnsOutbound = fullConfig.outbounds.find((outbound) => outbound.tag === 'dns-out');
  const dnsServers = fullConfig.dns.servers;

  assert.ok(dnsOutbound, 'full client config should include a dns-out outbound');
  assert.strictEqual(dnsOutbound.protocol, 'dns');
  assert.deepStrictEqual(fullConfig.routing.rules[0], {
    type: 'field',
    inboundTag: ['socks', 'http'],
    port: '53',
    outboundTag: 'dns-out',
  });
  assert.deepStrictEqual(fullConfig.routing.rules[1], {
    type: 'field',
    inboundTag: ['dns-proxy'],
    outboundTag: 'proxy',
  });
  assert.deepStrictEqual(fullConfig.routing.rules[2], {
    type: 'field',
    inboundTag: ['dns-direct'],
    outboundTag: 'direct',
  });
  assert.strictEqual(fullConfig.dns.queryStrategy, 'UseIPv4');
  assert.ok(
    dnsServers.some((server) => (
      server.address === '223.5.5.5' &&
      server.tag === 'dns-direct' &&
      server.domains.includes('domain:weixin.qq.com') &&
      server.domains.includes('geosite:cn')
    )),
    'domestic DNS should use a direct domestic DNS server'
  );
  assert.ok(
    dnsServers.some((server) => (
      server.address === '8.8.8.8' &&
      server.tag === 'dns-proxy' &&
      server.domains.includes('geosite:geolocation-!cn')
    )),
    'foreign DNS should use the proxy path'
  );
  assert.ok(
    dnsServers.some((server) => (
      server.address === '223.5.5.5' &&
      server.tag === 'dns-direct' &&
      !server.domains
    )),
    'unmatched DNS queries should fall back to a direct domestic DNS server'
  );
  assert.ok(
    dnsServers.every((server) => !Object.hasOwn(server, 'outboundTag')),
    'Xray DNS server entries must use tag + routing, not ignored outboundTag'
  );
}

function testServerDnsUsesTaggedQueryRoute() {
  const serverConfig = createServerConfig({
    mode: 'proxy',
    uuid: sample.uuid,
    privateKey: sample.privateKey,
    shortId: sample.shortId,
    ispProxy: sample.ispProxy,
  });

  assert.ok(
    serverConfig.dns.servers.every((server) => server.tag === 'dns-proxy'),
    'server DNS queries should carry a routing tag'
  );
  assert.ok(
    serverConfig.dns.servers.every((server) => !Object.hasOwn(server, 'outboundTag')),
    'server DNS entries must not use ignored outboundTag'
  );
  assert.ok(
    serverConfig.routing.rules.some((rule) => (
      rule.inboundTag && rule.inboundTag.includes('dns-proxy') && rule.outboundTag === 'proxy'
    )),
    'server should route tagged DNS queries through its proxy outbound'
  );
}

function testClientFullConfigKeepsTigerProxyBeforeDomesticDirectRules() {
  const generated = generateClientConfig(sample);
  const fullConfig = JSON.parse(generated.fullConfig);
  const rules = fullConfig.routing.rules;
  const tigerProxyIndex = rules.findIndex((rule) => (
    rule.outboundTag === 'proxy' &&
    rule.domain &&
    rule.domain.includes('domain:itiger.com') &&
    rule.domain.includes('domain:laohu8.com') &&
    rule.domain.includes('domain:tigerbrokers.com.au')
  ));
  const domesticDomainIndex = rules.findIndex((rule) => (
    rule.outboundTag === 'direct' &&
    rule.domain &&
    rule.domain.includes('domain:weixin.qq.com') &&
    rule.domain.includes('domain:tencent.com') &&
    rule.domain.includes('geosite:cn')
  ));
  const cnIpIndex = rules.findIndex((rule) => (
    rule.outboundTag === 'direct' &&
    rule.ip &&
    rule.ip.includes('geoip:private') &&
    rule.ip.includes('geoip:cn')
  ));
  const udp443BlockIndex = rules.findIndex((rule) => (
    rule.outboundTag === 'block' &&
    rule.port === '443' &&
    rule.network === 'udp'
  ));
  const openAiProxyIndex = rules.findIndex((rule) => (
    rule.outboundTag === 'proxy' &&
    rule.domain &&
    rule.domain.includes('domain:openai.com')
  ));
  const foreignProxyIndex = rules.findIndex((rule) => (
    rule.outboundTag === 'proxy' &&
    rule.domain &&
    rule.domain.includes('geosite:geolocation-!cn')
  ));

  assert.strictEqual(fullConfig.outbounds[0].tag, 'proxy', 'unmatched traffic should default to the proxy outbound');
  assert.ok(tigerProxyIndex > 0, 'Tiger Brokers proxy rule should exist after DNS routing');
  assert.ok(domesticDomainIndex > tigerProxyIndex, 'domestic domain direct rule should follow Tiger Brokers proxy rule');
  assert.ok(cnIpIndex > domesticDomainIndex, 'CN IP direct rule should follow the domain direct rule');
  assert.ok(udp443BlockIndex > cnIpIndex, 'UDP 443 block should not preempt domestic direct rules');
  assert.ok(openAiProxyIndex > udp443BlockIndex, 'OpenAI proxy rule should stay after direct and UDP block rules');
  assert.ok(foreignProxyIndex > openAiProxyIndex, 'foreign proxy rule should stay after OpenAI proxy rule');
  assert.deepStrictEqual(rules[cnIpIndex].ip, ['geoip:private', 'geoip:cn']);
}

function testTigerDomainsUseClientProxyBeforeDomesticDirectRules() {
  const expectedTigerDomains = [
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
  assert.deepStrictEqual(TIGER_PROXY_DOMAINS, expectedTigerDomains);

  const generated = generateClientConfig(sample);
  const fullConfig = JSON.parse(generated.fullConfig);
  assert.ok(
    fullConfig.dns.servers.some((server) => (
      server.address === '8.8.8.8' &&
      server.tag === 'dns-proxy' &&
      server.domains.includes('domain:itiger.com')
    )),
    'Tiger Brokers DNS should use a proxy-routed overseas DNS server'
  );

  const clientRules = fullConfig.routing.rules;
  assert.strictEqual(
    fullConfig.routing.domainMatcher,
    'hybrid',
    'hybrid domain matcher should support keyword-style Tiger Brokers rules'
  );
  const tigerClientIndex = clientRules.findIndex((rule) => (
    rule.outboundTag === 'proxy' &&
    rule.domain &&
    rule.domain.includes('domain:itiger.com') &&
    rule.domain.includes('domain:laohu8.com') &&
    rule.domain.includes('domain:tigerbrokers.com.au') &&
    rule.domain.includes('keyword:tiger') &&
    rule.domain.includes('keyword:upfintech')
  ));
  const domesticClientIndex = clientRules.findIndex((rule) => (
    rule.outboundTag === 'direct' &&
    rule.domain &&
    rule.domain.includes('domain:weixin.qq.com') &&
    rule.domain.includes('geosite:cn')
  ));

  assert.ok(tigerClientIndex > 0, 'Tiger Brokers proxy rule should exist after DNS routing');
  assert.ok(
    tigerClientIndex < domesticClientIndex,
    'Tiger Brokers proxy rule should preempt domestic direct rules'
  );
}

function testTigerIpOnlyTradingTrafficUsesProxyBeforeDomesticDirectRules() {
  const expectedTigerPorts = '7000-7007,19000';
  const expectedTigerIps = [
    '39.96.129.161',
    '101.91.29.17',
    '120.25.143.214',
    '121.46.23.34',
    '124.237.224.103',
    '220.181.111.0/24',
  ];
  assert.strictEqual(TIGER_PROXY_PORTS, expectedTigerPorts);
  assert.deepStrictEqual(TIGER_PROXY_IPS, expectedTigerIps);

  const generated = generateClientConfig(sample);
  const fullConfig = JSON.parse(generated.fullConfig);
  const rules = fullConfig.routing.rules;
  const tigerPortIndex = rules.findIndex((rule) => (
    rule.outboundTag === 'proxy' &&
    rule.port === TIGER_PROXY_PORTS
  ));
  const tigerIpIndex = rules.findIndex((rule) => (
    rule.outboundTag === 'proxy' &&
    rule.ip &&
    rule.ip.includes('39.96.129.161') &&
    rule.ip.includes('220.181.111.0/24')
  ));
  const cnIpIndex = rules.findIndex((rule) => (
    rule.outboundTag === 'direct' &&
    rule.ip &&
    rule.ip.includes('geoip:cn')
  ));

  assert.ok(tigerPortIndex > 0, 'Tiger Brokers trading-port proxy rule should exist');
  assert.ok(tigerIpIndex > tigerPortIndex, 'Tiger Brokers observed IP proxy rule should follow the port rule');
  assert.ok(tigerIpIndex < cnIpIndex, 'Tiger Brokers IP proxy rule should preempt geoip:cn direct');
}

function testTigerDomainsDoNotRequireServerRoutingChanges() {
  const serverConfig = createServerConfig({
    mode: 'proxy',
    uuid: sample.uuid,
    privateKey: sample.privateKey,
    shortId: sample.shortId,
    ispProxy: sample.ispProxy,
  });

  assert.ok(
    serverConfig.routing.rules.some((rule) => (
      rule.outboundTag === 'proxy' &&
      rule.inboundTag &&
      rule.inboundTag.includes('vless-in')
    )),
    'server should keep the existing catch-all proxy rule for VLESS inbound traffic'
  );
  assert.ok(
    serverConfig.routing.rules.every((rule) => (
      !rule.domain || !rule.domain.includes('domain:itiger.com')
    )),
    'Tiger Brokers should not require a dedicated server-side routing rule'
  );

  const script = generateOptimizeScript();
  assert.doesNotMatch(script, /TIGER_PROXY_DOMAINS/);
  assert.doesNotMatch(script, /tiger_rule/);
}

function testOptimizeScriptDoesNotModifyServerRoutingForWechat() {
  const script = generateOptimizeScript();

  assert.doesNotMatch(script, /WECHAT_DIRECT_DOMAINS/);
  assert.doesNotMatch(script, /wechat_rule/);
  assert.doesNotMatch(script, /微信直连/);
}

function testOptimizeScriptKeepsServerRoutingStrategyMinimal() {
  const script = generateOptimizeScript();

  assert.match(script, /routing\['domainStrategy'\] = 'AsIs'/);
  assert.doesNotMatch(script, /domainMatcher/);
}

function testGuideExplainsFullJsonImportWorkflow() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const visibleText = html.replace(/<[^>]+>/g, ' ');

  assert.match(visibleText, /重新生成配置/);
  assert.match(visibleText, /复制完整配置/);
  assert.match(visibleText, /微信直连和 DNS 优化/);
  assert.match(visibleText, /保存为.*\.json/);
  assert.match(visibleText, /发送到手机/);
  assert.match(visibleText, /电脑.*本地导入/);
  assert.match(visibleText, /手机.*本地导入/);
  assert.match(visibleText, /v2rayN/);
  assert.match(visibleText, /v2rayNG/);
}

function testGuideExplainsXrayOptimizationWorkflow() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const visibleText = html.replace(/<[^>]+>/g, ' ');

  assert.match(visibleText, /修复并优化配置/);
  assert.match(visibleText, /BBR/);
  assert.match(visibleText, /TCP Fast Open/);
  assert.match(visibleText, /何时使用/);
  assert.match(visibleText, /VLESS 链接不会因此改变/);
  assert.match(visibleText, /失败处理/);
}

function testFaqExplainsWechatAndDomesticSlowAccess() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const visibleText = html.replace(/<[^>]+>/g, ' ');

  assert.match(visibleText, /微信或国内访问慢怎么办/);
  assert.match(visibleText, /不要只扫描二维码或导入 VLESS 链接/);
  assert.match(visibleText, /重新生成配置/);
  assert.match(visibleText, /复制完整配置/);
  assert.match(visibleText, /完整 JSON/);
  assert.match(visibleText, /v2rayN\/v2rayNG/);
  assert.match(visibleText, /本地导入/);
  assert.match(visibleText, /微信直连和 DNS 优化/);
}

async function testClientRegenerateFailureDoesNotReportSuccess() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'client.js'), 'utf8');
  const notifications = [];
  const elements = new Map();

  function createElement(id) {
    return {
      id,
      style: {},
      value: '',
      innerHTML: '',
      listeners: {},
      addEventListener(event, handler) {
        this.listeners[event] = handler;
      },
      getContext() {
        return { drawImage() {} };
      },
      appendChild() {},
      removeChild() {},
      select() {},
    };
  }

  [
    'btnCopyLink',
    'btnCopyFullConfig',
    'btnRegenerateConfig',
    'vlessLink',
    'qrSection',
    'configSection',
    'configTableBody',
    'qrCanvas',
    'clientImportHint',
  ].forEach((id) => elements.set(id, createElement(id)));

  const infoBox = createElement('infoBox');
  const context = {
    window: {
      App: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
      api: {
        client: {
          generateConfig: async () => ({ success: false, error: 'boom' }),
        },
        qrcode: {
          generate: async () => ({ success: false }),
        },
      },
    },
    document: {
      getElementById(id) {
        return elements.get(id) || createElement(id);
      },
      querySelector(selector) {
        return selector === '.client-info-box' ? infoBox : null;
      },
      createElement,
      body: createElement('body'),
    },
    navigator: { clipboard: { writeText: async () => {} } },
    console: { error() {}, log() {} },
    Image: function Image() {},
  };
  context.App = context.window.App;

  vm.runInNewContext(source, context, { filename: 'client.js' });
  context.window.App.client.init();
  context.window.App.client.updateClientPage({
    deploy: {
      deployed: true,
      vpsIP: sample.vpsIP,
      uuid: sample.uuid,
      publicKey: sample.publicKey,
      shortId: sample.shortId,
    },
  });

  await elements.get('btnRegenerateConfig').listeners.click();

  assert.ok(
    notifications.some((notification) => notification.type === 'error' && notification.message.includes('boom')),
    'regenerate failure should surface the IPC error'
  );
  assert.ok(
    notifications.every((notification) => notification.type !== 'success'),
    'regenerate failure must not show a success notification'
  );
}

function createDashboardElement(id) {
  const selectorChildren = new Map();
  const classNames = new Set();

  const element = {
    id,
    style: {},
    textContent: '',
    disabled: false,
    listeners: {},
    className: '',
    classList: {
      add(className) {
        classNames.add(className);
      },
      remove(className) {
        classNames.delete(className);
      },
      toggle(className, force) {
        if (force) {
          classNames.add(className);
        } else {
          classNames.delete(className);
        }
      },
      contains(className) {
        return classNames.has(className);
      },
    },
    addEventListener(event, handler) {
      this.listeners[event] = handler;
    },
    querySelector(selector) {
      if (!selectorChildren.has(selector)) {
        selectorChildren.set(selector, createDashboardElement(`${id}:${selector}`));
      }
      return selectorChildren.get(selector);
    },
  };

  return element;
}

function createDashboardTestContext(apiOverrides = {}) {
  const elements = new Map();
  [
    'connectionStatus',
    'btnRefresh',
    'dashConnectionState',
    'dashCurrentMode',
    'dashExitIP',
    'btnModeIspProxy',
    'btnModeDirect',
    'btnVerifyIP',
    'btnCheckXray',
    'btnOptimizeXray',
  ].forEach((id) => elements.set(id, createDashboardElement(id)));

  const api = {
    ssh: {
      connect: async () => ({ success: true }),
      optimize: async () => ({ success: true, data: { bbr: 'net.ipv4.tcp_congestion_control = bbr' } }),
      onStatusChange() {},
    },
    xray: {
      status: async () => ({ success: true, data: 'active\nenabled' }),
      currentMode: async () => ({ success: true, data: 'socks' }),
      verifyIp: async () => ({ success: true, data: '203.0.113.10' }),
      verifyIspProxy: async () => ({ success: true, data: '198.51.100.20' }),
      switchMode: async () => ({ success: true }),
    },
  };

  if (apiOverrides.xray) {
    api.xray = { ...api.xray, ...apiOverrides.xray };
  }
  if (apiOverrides.ssh) {
    api.ssh = { ...api.ssh, ...apiOverrides.ssh };
  }

  const notifications = [];
  const context = {
    window: {
      App: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
      api,
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createDashboardElement(id));
        return elements.get(id);
      },
    },
    console: { error() {}, log() {} },
  };
  context.App = context.window.App;

  return { context, elements, notifications };
}

async function testDashboardShowsConfiguredIspExitIpForProxyMode() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'dashboard.js'), 'utf8');
  const calls = { verifyIp: 0, verifyIspProxy: 0 };
  const { context, elements } = createDashboardTestContext({
    xray: {
      currentMode: async () => ({ success: true, data: 'socks' }),
      verifyIp: async () => {
        calls.verifyIp++;
        return { success: true, data: sample.vpsIP };
      },
      verifyIspProxy: async (config) => {
        calls.verifyIspProxy++;
        assert.deepStrictEqual(config, sample.ispProxy);
        return { success: true, data: sample.ispProxy.address };
      },
    },
  });

  vm.runInNewContext(source, context, { filename: 'dashboard.js' });
  await context.window.App.dashboard.refreshDashboard({
    vps: { host: sample.vpsIP, port: '22', username: 'root' },
    ispProxy: sample.ispProxy,
  });

  assert.strictEqual(calls.verifyIspProxy, 1);
  assert.strictEqual(calls.verifyIp, 0);
  assert.strictEqual(elements.get('dashCurrentMode').textContent, 'ISP 代理');
  assert.strictEqual(elements.get('dashExitIP').textContent, sample.ispProxy.address);
  assert.strictEqual(
    elements.get('btnModeIspProxy').querySelector('.mode-desc').textContent,
    `出口 ${sample.ispProxy.address}`
  );
}

async function testDashboardRunsOptimizationAndRefreshesStatus() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'dashboard.js'), 'utf8');
  const calls = { connect: 0, optimize: 0, status: 0 };
  const { context, elements, notifications } = createDashboardTestContext({
    ssh: {
      connect: async () => {
        calls.connect++;
        return { success: true };
      },
      optimize: async (vps) => {
        calls.optimize++;
        assert.strictEqual(vps.host, sample.vpsIP);
        return { success: true, data: { bbr: 'net.ipv4.tcp_congestion_control = bbr' } };
      },
    },
    xray: {
      status: async () => {
        calls.status++;
        return { success: true, data: 'active\nenabled' };
      },
    },
  });

  vm.runInNewContext(source, context, { filename: 'dashboard.js' });
  context.window.App.dashboard.init({
    vps: { host: sample.vpsIP, port: '22', username: 'root' },
    ispProxy: sample.ispProxy,
  });

  await elements.get('btnOptimizeXray').listeners.click();

  assert.ok(calls.connect >= 1, 'optimization should connect when SSH is not connected');
  assert.strictEqual(calls.optimize, 1, 'optimization should call the SSH optimization IPC once');
  assert.ok(calls.status >= 1, 'successful optimization should refresh Xray status');
  assert.strictEqual(elements.get('btnOptimizeXray').disabled, false, 'optimization button should be re-enabled');
  assert.strictEqual(elements.get('btnOptimizeXray').querySelector('.btn-text').textContent, '修复并优化配置');
  assert.ok(
    notifications.some((notification) => notification.type === 'success' && notification.message.includes('修复完成')),
    'successful optimization should report completion'
  );
}

async function testDashboardVerifyAndCheckButtonsShowBusyState() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'dashboard.js'), 'utf8');
  const busyState = { verify: null, check: null };
  const { context, elements, notifications } = createDashboardTestContext({
    xray: {
      currentMode: async () => ({ success: true, data: 'freedom' }),
      verifyIp: async () => {
        busyState.verify = {
          disabled: elements.get('btnVerifyIP').disabled,
          text: elements.get('btnVerifyIP').querySelector('.btn-text').textContent,
        };
        return { success: true, data: sample.vpsIP };
      },
      status: async () => {
        busyState.check = {
          disabled: elements.get('btnCheckXray').disabled,
          text: elements.get('btnCheckXray').querySelector('.btn-text').textContent,
        };
        return { success: true, data: 'active\nenabled' };
      },
    },
  });

  vm.runInNewContext(source, context, { filename: 'dashboard.js' });
  context.window.App.dashboard.init({
    vps: { host: sample.vpsIP, port: '22', username: 'root' },
    ispProxy: sample.ispProxy,
  });

  await elements.get('btnVerifyIP').listeners.click();
  await elements.get('btnCheckXray').listeners.click();

  // 请求进行中：按钮禁用并显示忙碌文案
  assert.deepStrictEqual(
    busyState.verify,
    { disabled: true, text: '验证中...' },
    'verify exit IP button must be disabled with busy text while the request is in flight'
  );
  assert.deepStrictEqual(
    busyState.check,
    { disabled: true, text: '检查中...' },
    'check status button must be disabled with busy text while the request is in flight'
  );

  // 请求结束：恢复可用与原始文案
  assert.strictEqual(elements.get('btnVerifyIP').disabled, false);
  assert.strictEqual(elements.get('btnVerifyIP').querySelector('.btn-text').textContent, '验证出口 IP');
  assert.strictEqual(elements.get('btnCheckXray').disabled, false);
  assert.strictEqual(elements.get('btnCheckXray').querySelector('.btn-text').textContent, '检查 Xray 状态');
  assert.ok(
    notifications.some((notification) => notification.type === 'success' && notification.message.includes('出口 IP')),
    'verify button should still report the exit IP on success'
  );
  assert.ok(
    notifications.some((notification) => notification.type === 'success' && notification.message.includes('Xray 运行中')),
    'check button should still report Xray status on success'
  );
}

async function testDashboardOptimizationFailureDoesNotReportSuccess() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'dashboard.js'), 'utf8');
  const calls = { optimize: 0, status: 0 };
  const { context, elements, notifications } = createDashboardTestContext({
    ssh: {
      optimize: async () => {
        calls.optimize++;
        return { success: false, error: 'Xray 启动校验失败' };
      },
    },
    xray: {
      status: async () => {
        calls.status++;
        return { success: true, data: 'active\nenabled' };
      },
    },
  });

  vm.runInNewContext(source, context, { filename: 'dashboard.js' });
  context.window.App.dashboard.init({
    vps: { host: sample.vpsIP, port: '22', username: 'root' },
    ispProxy: sample.ispProxy,
  });

  await elements.get('btnOptimizeXray').listeners.click();

  assert.strictEqual(calls.optimize, 1);
  assert.strictEqual(calls.status, 0, 'failed optimization must not refresh a successful status');
  assert.strictEqual(elements.get('btnOptimizeXray').disabled, false);
  assert.ok(
    notifications.some((notification) => notification.type === 'error' && notification.message.includes('Xray 启动校验失败')),
    'optimization failure should surface the original error'
  );
  assert.ok(
    notifications.every((notification) => notification.type !== 'success'),
    'optimization failure must not report success'
  );
}

function loadSSHManager(FakeClient) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'ssh.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, {
    require(request) {
      if (request === 'ssh2') return { Client: FakeClient };
      throw new Error(`Unexpected dependency: ${request}`);
    },
    module,
    exports: module.exports,
    Promise,
    setTimeout,
    clearTimeout,
  }, { filename: 'ssh.js' });
  return module.exports.SSHManager;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, description, timeoutMs = 200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await wait(5);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function testSSHReconnectRetriesAfterFailedReconnectAttempt() {
  class FakeClient extends EventEmitter {
    static plans = ['ready', 'error', 'error', 'error'];

    connect() {
      const plan = FakeClient.plans.shift();
      setTimeout(() => this.emit(plan, plan === 'error' ? new Error('network unavailable') : undefined), 0);
    }

    end() {}
  }

  const SSHManager = loadSSHManager(FakeClient);
  const manager = new SSHManager();
  manager.reconnectDelay = 1;
  const statuses = [];
  manager.onStatusChange = (status) => statuses.push(status);

  const connected = await manager.connect({ host: 'example.test', username: 'root' });
  assert.strictEqual(connected.success, true);

  manager.conn.emit('close');
  await waitFor(
    () => statuses.some((status) => status.status === 'failed'),
    'SSH reconnect attempts to be exhausted'
  );

  assert.strictEqual(FakeClient.plans.length, 0, 'all reconnect attempts should run after failures');
  assert.ok(statuses.some((status) => status.status === 'failed'), 'reconnect exhaustion should report failed');
}

async function testSSHExecTimesOutAndClosesTheChannel() {
  let channelClosed = false;

  class FakeClient extends EventEmitter {
    connect() {}

    exec(command, callback) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {
        channelClosed = true;
      };
      callback(null, stream);
    }
  }

  const SSHManager = loadSSHManager(FakeClient);
  const manager = new SSHManager();
  manager.conn = new FakeClient();
  manager.connected = true;
  manager.commandTimeout = 10;

  const timeoutSentinel = Symbol('timeout');
  const result = await Promise.race([
    manager.exec('sleep forever'),
    wait(80).then(() => timeoutSentinel),
  ]);

  assert.notStrictEqual(result, timeoutSentinel, 'command execution should settle before the test timeout');
  assert.strictEqual(result.success, false);
  assert.match(result.error, /超时|timed out/i);
  assert.strictEqual(channelClosed, true, 'timed out SSH channels should be closed');
}

async function testSSHTestConnectionFailsWhenItsProbeCommandFails() {
  class FakeClient extends EventEmitter {
    connect() {
      setTimeout(() => this.emit('ready'), 0);
    }

    end() {}
  }

  const SSHManager = loadSSHManager(FakeClient);
  const manager = new SSHManager();
  manager.exec = async () => ({ success: false, error: 'probe failed', data: '' });

  const result = await manager.testConnection({ host: 'example.test', username: 'root' });

  assert.strictEqual(result.success, false);
  assert.match(result.error, /probe failed/);
  assert.strictEqual(manager.isConnected(), false, 'test connection should leave no active SSH session');
}

async function testSuccessfulSSHProbeDoesNotMarkTheDashboardAsConnected() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'settings.js'), 'utf8');
  const elements = new Map();
  const dashboardCalls = [];

  function element(id, value = '') {
    return {
      id,
      value,
      disabled: false,
      innerHTML: '',
      textContent: '',
      listeners: {},
      addEventListener(event, handler) {
        this.listeners[event] = handler;
      },
    };
  }

  [
    ['vpsAuthType', 'password'],
    ['vpsHost', 'example.test'],
    ['vpsPort', '22'],
    ['vpsUsername', 'root'],
    ['vpsPassword', 'password'],
    ['vpsPrivateKey', ''],
    ['btnTestSSH', ''],
    ['btnSaveVPS', ''],
    ['btnSaveIspProxy', ''],
    ['vpsPasswordGroup', ''],
    ['vpsKeyGroup', ''],
    ['ispProxyAddress', ''],
    ['ispProxyPort', ''],
    ['ispProxyUsername', ''],
    ['ispProxyPassword', ''],
  ].forEach(([id, value]) => elements.set(id, element(id, value)));
  elements.get('vpsPasswordGroup').classList = { toggle() {} };
  elements.get('vpsKeyGroup').classList = { toggle() {} };

  const context = {
    window: {
      App: {
        notify() {},
        dashboard: {
          setConnectionState(...args) { dashboardCalls.push(['setConnectionState', ...args]); },
          updateConnectionStatus(...args) { dashboardCalls.push(['updateConnectionStatus', ...args]); },
        },
        deploy: { updateDeployChecklist() {} },
      },
      api: {
        ssh: { test: async () => ({ success: true }) },
        config: { save: async () => ({ success: true }) },
      },
    },
    document: { getElementById(id) { return elements.get(id); } },
  };
  context.App = context.window.App;

  vm.runInNewContext(source, context, { filename: 'settings.js' });
  context.window.App.settings.init({});
  await elements.get('btnTestSSH').listeners.click();

  assert.deepStrictEqual(dashboardCalls, [], 'a probe disconnects immediately and must not set dashboard connection state');
}

function loadMainHandlers(sshResults) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const handlers = new Map();
  const calls = [];
  const safeStorage = { isEncryptionAvailable: () => true };
  let configManagerOptions;

  class FakeSSHManager {
    async exec(command) {
      calls.push(command);
      const result = sshResults.shift() || { success: true, data: '' };
      return typeof result === 'function' ? result(command) : result;
    }

    disconnect() {}
  }

  const electron = {
    app: {
      whenReady: () => ({ then() {} }),
      on() {},
      quit() {},
    },
    BrowserWindow: class {},
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
    dialog: {},
    shell: { openExternal() {} },
    safeStorage,
  };
  const module = { exports: {} };

  vm.runInNewContext(source, {
    require(request) {
      if (request === 'electron') return electron;
      if (request === 'qrcode') return { toDataURL: async () => '' };
      if (request === './src/lib/ssh') return { SSHManager: FakeSSHManager };
      if (request === './src/lib/config') {
        return {
          ConfigManager: class {
            constructor(options) {
              configManagerOptions = options;
            }
          },
        };
      }
      if (request === './src/lib/xray-config') return require('../src/lib/xray-config');
      if (request === 'path') return path;
      throw new Error(`Unexpected dependency: ${request}`);
    },
    module,
    exports: module.exports,
    console: { error() {} },
    process: { platform: 'darwin' },
    Buffer,
    setTimeout,
  }, { filename: 'main.js' });

  return { handlers, calls, configManagerOptions, safeStorage };
}

function testMainInjectsSystemSafeStorageIntoConfigManager() {
  const { configManagerOptions, safeStorage } = loadMainHandlers([]);
  assert.strictEqual(configManagerOptions.safeStorage, safeStorage);
}

async function testDeploymentStopsWhenAnyRemoteStepFails() {
  const { handlers, calls } = loadMainHandlers([{ success: false, error: 'apt failed', data: '' }]);
  const result = await handlers.get('deploy:run')(null, {
    vps: { host: sample.vpsIP },
    ispProxy: sample.ispProxy,
  });

  assert.strictEqual(result.success, false);
  assert.match(result.error, /系统更新|apt failed/);
  assert.strictEqual(calls.length, 1, 'deployment must stop immediately after the failed step');
}

async function testOptimizationStopsWhenAnyRemoteStepFails() {
  const { handlers, calls } = loadMainHandlers([{ success: false, error: 'sysctl failed', data: '' }]);
  const result = await handlers.get('ssh:optimize')(null, {});

  assert.strictEqual(result.success, false);
  assert.match(result.error, /启用 BBR|sysctl failed/);
  assert.strictEqual(calls.length, 1, 'optimization must stop immediately after the failed step');
}

async function testModeSwitchValidatesAndRollsBackOnServiceFailure() {
  const { handlers, calls } = loadMainHandlers([{ success: true, data: '' }]);
  const result = await handlers.get('xray:switch-mode')(null, 'direct');

  assert.strictEqual(result.success, true);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /SOURCE_CONFIG='\/usr\/local\/etc\/xray\/modes\/direct\.json'/);
  assert.match(calls[0], /xray run -test -config "\$TEMP_CONFIG"/);
  assert.match(calls[0], /BACKUP_CONFIG="\/usr\/local\/etc\/xray\/config\.json\.backup\.\$\$"/);
  assert.match(calls[0], /mv "\$BACKUP_CONFIG" "\$ACTIVE_CONFIG"/);
  assert.match(calls[0], /systemctl is-active --quiet xray/);
}

async function testProxyModeSwitchFindsAProviderNeutralLegacyModeFile() {
  const { handlers, calls } = loadMainHandlers([{ success: true, data: '' }]);
  const result = await handlers.get('xray:switch-mode')(null, 'proxy');

  assert.strictEqual(result.success, true);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /SOURCE_CONFIG='\/usr\/local\/etc\/xray\/modes\/proxy\.json'/);
  assert.match(calls[0], /find .*\/modes.*! -name 'direct\.json'/);
  assert.match(calls[0], /test -n "\$SOURCE_CONFIG"/);
}

async function testDeploymentValidatesBothModeConfigsBeforeActivation() {
  const { handlers, calls } = loadMainHandlers([
    { success: true, data: '' },
    { success: true, data: '' },
    { success: true, data: '' },
    { success: true, data: '' },
    { success: true, data: `${sample.uuid}\n` },
    { success: true, data: 'PrivateKey: sample-private-key\nPassword (PublicKey): sample-public-key\n' },
    { success: true, data: `${sample.shortId}\n` },
  ]);
  const result = await handlers.get('deploy:run')(null, {
    vps: { host: sample.vpsIP },
    ispProxy: sample.ispProxy,
  });

  assert.strictEqual(result.success, true);
  assert.doesNotMatch(calls[0], /apt upgrade/, 'deployment must not perform an unbounded system upgrade');
  const modeWriteCommands = calls.filter((command) => command.includes("TARGET_CONFIG='/usr/local/etc/xray/modes/"));
  assert.strictEqual(modeWriteCommands.length, 2, 'both saved modes should use the validated write path');
  assert.ok(
    modeWriteCommands.every((command) => (
      command.startsWith('set -eu') && command.includes('xray run -test -config "$TEMP_CONFIG"')
    )),
    'each saved mode must pass Xray validation before replacing the mode file'
  );
  const activationCommand = calls.find((command) => command.includes("SOURCE_CONFIG='/usr/local/etc/xray/modes/proxy.json'"));
  assert.ok(activationCommand, 'deployment should activate the initial mode via the rollback-capable path');
  assert.match(activationCommand, /mv "\$BACKUP_CONFIG" "\$ACTIVE_CONFIG"/);
}

async function testIspVerificationDoesNotInterpolateCredentialsIntoShell() {
  const { handlers, calls } = loadMainHandlers([{ success: true, data: '203.0.113.11\n' }]);
  const password = 'bad"; touch /tmp/should-not-run; #';
  const result = await handlers.get('xray:verify-isp-proxy')(null, {
    address: 'proxy.example.test',
    port: '12345',
    username: 'user',
    password,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(calls.length, 1);
  assert.doesNotMatch(calls[0], /touch \/tmp\/should-not-run/);
  assert.doesNotMatch(calls[0], /bad";/);
  assert.match(calls[0], /--proxy-user "\$PROXY_CREDENTIALS"/);
  assert.match(calls[0], /base64 -d/);
}

async function testOptimizationEnablesTcpFastOpenAndRollsBackFailedRestart() {
  const { handlers, calls } = loadMainHandlers([
    { success: true, data: '' },
    { success: true, data: 'net.ipv4.tcp_congestion_control = bbr\nnet.ipv4.tcp_fastopen = 3\n' },
    { success: true, data: '' },
    { success: true, data: '' },
  ]);
  const result = await handlers.get('ssh:optimize')(null, {});

  assert.strictEqual(result.success, true);
  assert.match(calls[0], /net\.ipv4\.tcp_fastopen=3/);
  assert.match(calls[1], /net\.ipv4\.tcp_fastopen/);
  assert.match(calls[1], /net\.core\.default_qdisc/);
  assert.match(calls[3], /optimization-backup/);
  assert.match(calls[3], /cp "\$BACKUP_CONFIG" "\$ACTIVE_CONFIG"/);
}

async function testXrayOperationsAreSerialized() {
  let releaseFirstOperation;
  const pendingResult = new Promise((resolve) => { releaseFirstOperation = resolve; });
  const { handlers, calls } = loadMainHandlers([() => pendingResult]);

  const first = handlers.get('xray:switch-mode')(null, 'direct');
  await Promise.resolve();
  const second = await handlers.get('ssh:optimize')(null, {});

  assert.strictEqual(calls.length, 1, 'a second Xray operation must not run commands while the first is active');
  assert.strictEqual(second.success, false);
  assert.match(second.error, /正在执行/);

  releaseFirstOperation({ success: true, data: '' });
  const firstResult = await first;
  assert.strictEqual(firstResult.success, true);
}

function testVisibleCopyUsesGenericIspProxy() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const visibleText = html.replace(/<[^>]+>/g, ' ');

  assert.doesNotMatch(visibleText, /IspProxy/);
  assert.match(visibleText, /ISP 代理/);
}

function testHiddenNotificationIsFullyOutsideTheViewport() {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  const hiddenRule = css.match(/\.notification\s*\{([^}]*)\}/);
  const visibleRule = css.match(/\.notification\.show\s*\{([^}]*)\}/);

  assert.ok(hiddenRule, 'notification base style should exist');
  assert.ok(visibleRule, 'notification visible style should exist');
  assert.match(hiddenRule[1], /translateX\(calc\(100% \+ 24px\)\)/);
  assert.match(hiddenRule[1], /opacity:\s*0/);
  assert.match(hiddenRule[1], /pointer-events:\s*none/);
  assert.match(visibleRule[1], /opacity:\s*1/);
}

function testBrandingAndVersionAreGenericNovaBit() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const visibleText = html.replace(/<[^>]+>/g, ' ');

  assert.strictEqual(packageJson.name, 'novabit-proxy');
  assert.strictEqual(packageJson.version, '1.2.16');
  assert.strictEqual(packageLock.name, packageJson.name);
  assert.strictEqual(packageLock.version, packageJson.version);
  assert.strictEqual(packageLock.packages[''].name, packageJson.name);
  assert.strictEqual(packageLock.packages[''].version, packageJson.version);

  assert.strictEqual(packageJson.build.productName, 'NovaBit Proxy');
  assert.strictEqual(packageJson.build.mac.icon, 'assets/novabit-proxy-icon.icns');
  assert.strictEqual(packageJson.build.dmg.title, 'NovaBit Proxy');
  assert.strictEqual(packageJson.build.nsis.shortcutName, 'NovaBit Proxy');

  assert.match(html, /<title>NovaBit Proxy<\/title>/);
  assert.match(visibleText, /NovaBit Proxy v1\.2\.16/);
  assert.doesNotMatch(visibleText, /VPS Proxy(?: Manager)?/);
  assert.ok(
    fs.existsSync(path.join(__dirname, '..', 'assets', 'novabit-proxy-icon.icns')),
    'macOS icon file should exist for electron-builder'
  );
}

function testReadmeDocumentsCurrentOptimizationWorkflow() {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  assert.match(readme, /1\.2\.16/);
  assert.match(readme, /优化 Xray/);
  assert.match(readme, /BBR/);
  assert.match(readme, /TCP Fast Open/);
  assert.match(readme, /DNS/);
  assert.match(readme, /原子/);
  assert.match(readme, /回滚/);
  assert.match(readme, /SSH.*超时|超时.*SSH/);
  assert.match(readme, /完整 JSON/);
  assert.match(readme, /VLESS 链接不会改变/);
  assert.match(readme, /Reality SNI/);
}

function testPublicSurfacesUseCurrentBrandAndGenericProxyCopy() {
  const publicFiles = [
    'README.md',
    'build.sh',
    'src/index.html',
    'index.html',
  ].filter((file) => fs.existsSync(path.join(__dirname, '..', file)));
  const obsoletePublicCopy = /VPS Proxy(?: Manager)?\b|IspProxy|v1\.0\.0/;

  for (const file of publicFiles) {
    const rawText = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const text = file.endsWith('.html') ? rawText.replace(/<[^>]+>/g, ' ') : rawText;
    assert.doesNotMatch(text, obsoletePublicCopy, `${file} should use current branding and generic proxy copy`);
  }
}

function testMacIconSourceHasTransparentCanvas() {
  const iconPath = path.join(__dirname, '..', 'assets', 'novabit-proxy-icon-1024.png');
  const output = execFileSync('sips', ['-g', 'hasAlpha', iconPath], { encoding: 'utf8' });

  assert.match(output, /hasAlpha: yes/, 'macOS icon source should have transparent corners');
}

async function runTests() {
  const tests = [
    testConfigIsEncryptedAndUsesPrivatePermissions,
    testLegacyPlaintextConfigMigratesToEncryptedGenericProxyKey,
    testEncryptedConfigPreservesOtherCredentialShapedSettings,
    testLegacyPlaintextPermissionsTightenEvenWhenEncryptionIsUnavailable,
    testRepositorySourceUsesGenericIspProxyNaming,
    testClientMuxDisabled,
    testServerPolicyForLongLivedConnections,
    testOptimizeScriptUsesPythonJsonParsing,
    testOptimizeScriptValidatesTempConfigAsJson,
    testOptimizeRollbackReportsFailure,
    testOptimizeScriptMigratesLegacyDnsRouting,
    testOptimizeScriptEncodesRealitySniForPythonJson,
    testRealitySniChanged,
    testPackageLockVersionMatchesPackageVersion,
    testClientImportNoteExplainsRoutingRequiresFullConfig,
    testClientFullConfigRoutesDnsThroughDnsOutbound,
    testServerDnsUsesTaggedQueryRoute,
    testClientFullConfigKeepsTigerProxyBeforeDomesticDirectRules,
    testTigerDomainsUseClientProxyBeforeDomesticDirectRules,
    testTigerIpOnlyTradingTrafficUsesProxyBeforeDomesticDirectRules,
    testTigerDomainsDoNotRequireServerRoutingChanges,
    testOptimizeScriptDoesNotModifyServerRoutingForWechat,
    testOptimizeScriptKeepsServerRoutingStrategyMinimal,
    testGuideExplainsFullJsonImportWorkflow,
    testGuideExplainsXrayOptimizationWorkflow,
    testFaqExplainsWechatAndDomesticSlowAccess,
    testClientRegenerateFailureDoesNotReportSuccess,
    testDashboardShowsConfiguredIspExitIpForProxyMode,
    testDashboardRunsOptimizationAndRefreshesStatus,
    testDashboardVerifyAndCheckButtonsShowBusyState,
    testDashboardOptimizationFailureDoesNotReportSuccess,
    testSSHReconnectRetriesAfterFailedReconnectAttempt,
    testSSHExecTimesOutAndClosesTheChannel,
    testSSHTestConnectionFailsWhenItsProbeCommandFails,
    testSuccessfulSSHProbeDoesNotMarkTheDashboardAsConnected,
    testMainInjectsSystemSafeStorageIntoConfigManager,
    testDeploymentStopsWhenAnyRemoteStepFails,
    testOptimizationStopsWhenAnyRemoteStepFails,
    testModeSwitchValidatesAndRollsBackOnServiceFailure,
    testProxyModeSwitchFindsAProviderNeutralLegacyModeFile,
    testDeploymentValidatesBothModeConfigsBeforeActivation,
    testIspVerificationDoesNotInterpolateCredentialsIntoShell,
    testOptimizationEnablesTcpFastOpenAndRollsBackFailedRestart,
    testXrayOperationsAreSerialized,
    testVisibleCopyUsesGenericIspProxy,
    testHiddenNotificationIsFullyOutsideTheViewport,
    testBrandingAndVersionAreGenericNovaBit,
    testReadmeDocumentsCurrentOptimizationWorkflow,
    testPublicSurfacesUseCurrentBrandAndGenericProxyCopy,
    testMacIconSourceHasTransparentCanvas,
  ];
  const failures = [];

  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      failures.push({ name: test.name, error });
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAILED ${failure.name}`);
      console.error(failure.error);
    }
    process.exitCode = 1;
    return;
  }

  console.log('config generation tests passed');
}

runTests();
