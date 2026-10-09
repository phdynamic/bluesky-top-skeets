#!/usr/bin/env node
// Makes the signing key the server uses to prove it is really this site when people sign in with Bluesky.
// Run it once, put the single line it prints in the OAUTH_PRIVATE_KEY_JWK environment variable (on Railway:
// Variables), and keep it secret. Anyone with it can pose as your site. Make a new one any time to rotate.
const crypto = require('crypto');
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });
jwk.kid = 'kiosk-' + new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(3).toString('hex');
jwk.alg = 'ES256';
jwk.key_ops = ['sign'];
process.stdout.write(JSON.stringify(jwk) + '\n');
process.stderr.write('\nCopy the line above into OAUTH_PRIVATE_KEY_JWK. Do not commit it or share it.\n');
