// Secrets live in the macOS Keychain, never in the JobTrack database.
const { execFile } = require('child_process');
const SERVICE = 'JobTrack';

const run = (args) => new Promise((resolve, reject) =>
  execFile('/usr/bin/security', args, { timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))));

const setSecret = (account, value) => run(['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', value]);
const getSecret = (account) => run(['find-generic-password', '-s', SERVICE, '-a', account, '-w']).catch(() => null);
const deleteSecret = (account) => run(['delete-generic-password', '-s', SERVICE, '-a', account]).catch(() => null);

module.exports = { setSecret, getSecret, deleteSecret };
