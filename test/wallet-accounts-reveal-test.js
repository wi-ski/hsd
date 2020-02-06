/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');
const {WalletClient} = require('hs-client');

const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

const wclient = new WalletClient({
  port: network.walletPort
});

const {wdb} = node.require('walletdb');
const name = rules.grindName(10, 20, network);

let wallet, alice, bob, aliceMiner, bobMiner;

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('One wallet, two accounts, one name', function() {
  before(async () => {
    await node.open();
    await wclient.open();

    wallet = await wdb.create();

    alice = await wallet.createAccount({name: 'alice'});
    bob = await wallet.createAccount({name: 'bob'});

    aliceMiner = await alice.receiveAddress();
    bobMiner = await bob.receiveAddress();
  });

  after(async () => {
    await wclient.close();
    await node.close();
  });

  it('should fund both accounts', async () => {
    await mineBlocks(10, aliceMiner);
    await mineBlocks(10, bobMiner);

    // Wallet rescan is an effective way to ensure that
    // wallet and chain are synced before proceeding.
    await wdb.rescan(0);

    const aliceBal = await wallet.getBalance('alice');
    const bobBal = await wallet.getBalance('bob');
    assert(aliceBal.confirmed === 2000 * 10 * 1e6);
    assert(bobBal.confirmed === 2000 * 10 * 1e6);
  });

  it('should open an auction and proceed to REVEAL phase', async () => {
    await wallet.sendOpen(name, false, {account: 'alice'});
    await mineBlocks(network.names.treeInterval + 2);
    let ns = await node.chain.db.getNameStateByName(name);
    assert(ns.isBidding(node.chain.height, network));

    await wdb.rescan(0);

    await wallet.sendBid(name, 100000, 200000, {account: 'alice'});
    await wallet.sendBid(name, 50000, 200000, {account: 'bob'});
    await mineBlocks(network.names.biddingPeriod);
    ns = await node.chain.db.getNameStateByName(name);
    assert(ns.isReveal(node.chain.height, network));

    await wdb.rescan(0);

    const walletBids = await wallet.getBidsByName(name);
    assert.strictEqual(walletBids.length, 2);

    for (const bid of walletBids)
      assert(bid.own);
  });

  it('should send REVEAL from one account at a time -- LIBRARY', async () => {
    const tx1 = await wallet.sendReveal(name, {account: 'alice'});
    assert(tx1);

    const tx2 = await wallet.sendReveal(name, {account: 'bob'});
    assert(tx2);

    // Reset for next test
    await wallet.abandon(tx1.hash());
    await wallet.abandon(tx2.hash());
  });

  it('should send REVEAL from all accounts -- LIBRARY', async () => {
    const tx = await wallet.sendRevealAll();
    assert(tx);

    // Reset for next test
    await wallet.abandon(tx.hash());
  });

  it('should send REVEAL from one account at a time -- HTTP', async () => {
    const tx1 = await wclient.post(`/wallet/${wallet.id}/reveal`, {
      name: name,
      account: 'alice'
    });
    assert(tx1);

    const tx2 = await wclient.post(`/wallet/${wallet.id}/reveal`, {
      name: name,
      account: 'bob'
    });
    assert(tx2);

    // Reset for next test
    await wallet.abandon(Buffer.from(tx1.hash, 'hex'));
    await wallet.abandon(Buffer.from(tx2.hash, 'hex'));
  });

  it('should send REVEAL from all accounts -- HTTP', async () => {
    const tx = await wclient.post(`/wallet/${wallet.id}/reveal`, {
      name: name
    });
    assert(tx);

    // Reset for next test
    await wallet.abandon(Buffer.from(tx.hash, 'hex'));
  });

  it('should send REVEAL from one account at a time -- RPC', async () => {
    await wclient.execute('selectwallet', [wallet.id]);

    const tx1 = await wclient.execute('sendreveal', [name, 'alice']);
    assert(tx1);

    const tx2 = await wclient.execute('sendreveal', [name, 'bob']);
    assert(tx2);

    // Reset for next test
    await wallet.abandon(Buffer.from(tx1.hash, 'hex'));
    await wallet.abandon(Buffer.from(tx2.hash, 'hex'));
  });

  it('should send REVEAL from all accounts -- RPC', async () => {
    const tx = await wclient.execute('sendreveal', [name]);
    assert(tx);

    // Reset for next test
    await wallet.abandon(Buffer.from(tx.hash, 'hex'));
  });
});
