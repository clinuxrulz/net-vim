#!/usr/bin/env node

import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { URL } from 'url';
import crypto from 'crypto';
import qrcode from 'qrcode-terminal';

/**
 * Net-Vim Bridge CLI (Node.js version)
 * A pure Node.js implementation of the Net-Vim file system bridge.
 */

const args = process.argv.slice(2);
const port = parseInt(args[0] || '8080', 10);
const rootDir = path.resolve(args[1] || process.cwd());
const key = crypto.randomUUID();

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Key');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Authentication
  const authHeader = req.headers['x-bridge-key'];
  if (authHeader !== key) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized (Invalid X-Bridge-Key)');
    return;
  }

  try {
    const parsedUrl = new URL(req.url, `http://localhost:${port}`);
    const relPath = (parsedUrl.searchParams.get('path') || '').replace(/^\/+/, '');
    const fullPath = path.join(rootDir, relPath);

    // Security: Ensure the path is within the root directory
    if (!fullPath.startsWith(rootDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: Path outside of root directory');
      return;
    }

    if (parsedUrl.pathname === '/ls' && req.method === 'GET') {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const result = entries.map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } 
    else if (parsedUrl.pathname === '/cat' && req.method === 'GET') {
      try {
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Path is a directory');
          return;
        }
        const content = await fs.readFile(fullPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(content);
      } catch (e) {
        if (e.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('File not found');
        } else {
          throw e;
        }
      }
    } 
    else if (parsedUrl.pathname === '/write' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          // Ensure parent directory exists
          const parent = path.dirname(fullPath);
          await fs.mkdir(parent, { recursive: true });

          await fs.writeFile(fullPath, body, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
        } catch (e) {
          console.error(`Failed to write file ${fullPath}:`, e);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Failed to write file: ${e.message}`);
        }
      });
    } 
    else if (parsedUrl.pathname === '/is_dir' && req.method === 'GET') {
      try {
        const stats = await fs.stat(fullPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ is_dir: stats.isDirectory() }));
      } catch (e) {
        if (e.code === 'ENOENT') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ is_dir: false }));
        } else {
          throw e;
        }
      }
    } 
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (err) {
    console.error(`Error processing ${req.method} ${req.url}:`, err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Internal Server Error: ${err.message}`);
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log("\n====================================================");
  console.log(`Bridge server (Node.js) running on http://0.0.0.0:${port}`);
  console.log(`Root Directory: ${rootDir}`);
  console.log(`Bridge Security Key: ${key}`);
  console.log("\nScan to copy the Security Key:");
  qrcode.generate(key, { small: true });
  console.log("\nTo connect from Net-Vim, use command:");
  console.log(`:ed bridge ${port} ${key}`);
  console.log("====================================================\n");
});

let isShuttingDown = false;

const handleExit = (signal) => {
  if (isShuttingDown) {
    console.log(`\nReceived ${signal} again. Exiting immediately...`);
    process.exit(1);
  }
  isShuttingDown = true;
  console.log(`\nReceived ${signal}. Shutting down bridge server...`);
  
  // Set a timeout to force exit if it takes too long
  const forceExitTimeout = setTimeout(() => {
    console.log('Shutdown timed out. Exiting immediately...');
    process.exit(1);
  }, 3000);
  forceExitTimeout.unref();

  server.close(() => {
    clearTimeout(forceExitTimeout);
    console.log('Bridge server closed.');
    process.exit(0);
  });
};

process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));
