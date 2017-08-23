#!/usr/bin/env node

const Path = require('path');
const yargs = require('yargs');
const Koa = require('koa');
const koaStatic = require('koa-static');
const koaSSR = require('.');

const config = {}

try { Object.assign(config, require(Path.join(process.cwd(), 'koa-ssr'))); } catch (error) {}
try { Object.assign(config, require(Path.join(process.cwd(), '.koa-ssr'))); } catch (error) {}

Object.assign(config, yargs.argv);

config.root = config.root || 'build';
config.port = config.port || 8000;

const app = new Koa();

app.use(koaStatic(config.root, config.static))

app.use(koaSSR(config.root, config))

app.listen(config.port, error => error ? console.error(error) : console.log(`Listening at ${config.port}`));
