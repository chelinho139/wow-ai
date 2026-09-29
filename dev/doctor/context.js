'use strict';
const path = require('path');
const H = require('../../bridge/home');
const Service = require('../../bridge/service');

const LABEL = Service.LABEL;

function unescapeXml(text) {
  return String(text).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function parsePlist(xml) {
  if (!xml) return null;
  const valueAfterKey = key => {
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
    return match ? unescapeXml(match[1]) : '';
  };
  const argsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  const programArguments = argsBlock ? [...argsBlock[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => unescapeXml(m[1])) : [];
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml);
  const env = {};
  if (envBlock) for (const m of envBlock[1].matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) env[unescapeXml(m[1])] = unescapeXml(m[2]);
  return {
    label: valueAfterKey('Label'),
    node: programArguments[0] || '',
    script: programArguments[1] || '',
    programArguments,
    workingDirectory: valueAfterKey('WorkingDirectory'),
    logFile: valueAfterKey('StandardOutPath'),
    env,
  };
}

function checkoutOf(plist) {
  if (plist && plist.script) return path.dirname(path.dirname(plist.script));
  return plist && plist.workingDirectory ? plist.workingDirectory : '';
}

function parseJson(text) {
  if (text === null || text === undefined) return { present: false, value: null, error: null };
  try { return { present: true, value: JSON.parse(text), error: null }; } catch (e) { return { present: true, value: null, error: e.message }; }
}

function gather(sys) {
  const serviceDirs = Service.dirs('darwin', sys.env, sys.home);
  const plistText = sys.readText(serviceDirs.definition);
  const plist = parsePlist(plistText);
  const checkout = checkoutOf(plist);
  const serviceEnv = plist ? plist.env : {};
  const homeEnv = serviceEnv.CLAUDE_WOW_HOME ? { CLAUDE_WOW_HOME: serviceEnv.CLAUDE_WOW_HOME } : {};
  const legacyDir = checkout ? path.join(checkout, 'bridge') : '';
  const homePaths = H.resolve(homeEnv, sys.home, legacyDir);
  const configJson = parseJson(sys.readText(homePaths.config));
  const stateJson = parseJson(sys.readText(homePaths.state));
  const transcriptsJson = parseJson(sys.readText(homePaths.transcripts));
  const pidJson = parseJson(sys.readText(Service.pidFile(serviceDirs)));
  return {
    sys,
    now: sys.now(),
    label: LABEL,
    serviceDirs,
    plistPath: serviceDirs.definition,
    plist,
    checkout,
    homePaths,
    config: configJson.value || {},
    configJson,
    stateJson,
    transcriptsJson,
    state: stateJson.value || {},
    pidInfo: pidJson.value,
    serviceLog: Service.serviceLogFile(serviceDirs),
  };
}

module.exports = { gather, parsePlist, checkoutOf, parseJson, LABEL };
