/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');
const Resource = require('../lib/dns/resource');
const {WalletClient} = require('hs-client');

const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

// Prevent mempool from sending duplicate TXs back to the walletDB and txdb.
// This will prevent a race condition when we need to remove spent (but
// unconfirmed) outputs from the wallet so they can be reused in other tests.
node.mempool.emit = () => {};

const wclient = new WalletClient({
  port: network.walletPort
});

const {wdb} = node.require('walletdb');

const name = rules.grindName(5, 1, network);
let wallet, alice, bob, aliceReceive, bobReceive;

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('Multiple accounts participating in same auction', function() {
  before(async () => {
    await node.open();
    await wclient.open();

    wallet = await wdb.create();

    // We'll use an account number for alice and a string for bob
    // to ensure that both types work as options.
    alice = await wallet.getAccount(0);
    bob = await wallet.createAccount({name: 'bob'});

    aliceReceive = await alice.receiveAddress();
    bobReceive = await bob.receiveAddress();
  });

  after(async () => {
    await wclient.close();
    await node.close();
  });

  it('should fund both accounts', async () => {
    await mineBlocks(2, aliceReceive);
    await mineBlocks(2, bobReceive);

    // Wallet rescan is an effective way to ensure that
    // wallet and chain are synced before proceeding.
    await wdb.rescan(0);

    const aliceBal = await wallet.getBalance(0);
    const bobBal = await wallet.getBalance('bob');
    assert(aliceBal.confirmed === 2000 * 2 * 1e6);
    assert(bobBal.confirmed === 2000 * 2 * 1e6);
  });

  it('should open an auction and proceed to REVEAL phase', async () => {
    await wallet.sendOpen(name, false, {account: 0});
    await mineBlocks(network.names.treeInterval + 2);
    let ns = await node.chain.db.getNameStateByName(name);
    assert(ns.isBidding(node.chain.height, network));

    await wdb.rescan(0);

    await wallet.sendBid(name, 100000, 200000, {account: 0});
    await wallet.sendBid(name, 50000, 200000, {account: 'bob'});
    await mineBlocks(network.names.biddingPeriod);
    ns = await node.chain.db.getNameStateByName(name);
    assert(ns.isReveal(node.chain.height, network));

    await wdb.rescan(0);

    const walletBids = await wallet.getBidsByName(name);
    assert.strictEqual(walletBids.length, 2);

    for (const bid of walletBids)
      assert(bid.own);

    assert.strictEqual(node.mempool.map.size, 0);
  });

  describe('REVEAL', function() {
    describe('Library methods', function() {
      it('one tx per account', async () => {
        const tx1 = await wallet.sendReveal(name, {account: 0});
        assert(tx1);

        const tx2 = await wallet.sendReveal(name, {account: 'bob'});
        assert(tx2);

        // Reset for next test
        await wallet.abandon(tx1.hash());
        await wallet.abandon(tx2.hash());

        assert.strictEqual(node.mempool.map.size, 2);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });

      it('all accounts in one tx', async () => {
        const tx = await wallet.sendRevealAll();
        assert(tx);

        // Reset for next test
        await wallet.abandon(tx.hash());

        assert.strictEqual(node.mempool.map.size, 1);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });
    });

    describe('HTTP API', function () {
      it('one tx per account', async () => {
        const tx1 = await wclient.post(`/wallet/${wallet.id}/reveal`, {
          name: name,
          account: 'default'
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

        assert.strictEqual(node.mempool.map.size, 2);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });

      it('all accounts in one tx', async () => {
        const tx = await wclient.post(`/wallet/${wallet.id}/reveal`, {
          name: name
        });
        assert(tx);

        // Reset for next test
        await wallet.abandon(Buffer.from(tx.hash, 'hex'));

        assert.strictEqual(node.mempool.map.size, 1);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });
    });

    describe('RPC API', function() {
      it('one tx per account', async () => {
        await wclient.execute('selectwallet', [wallet.id]);

        const tx1 = await wclient.execute('sendreveal', [name, 'default']);
        assert(tx1);

        const tx2 = await wclient.execute('sendreveal', [name, 'bob']);
        assert(tx2);

        // Reset for next test
        await wallet.abandon(Buffer.from(tx1.hash, 'hex'));
        await wallet.abandon(Buffer.from(tx2.hash, 'hex'));

        assert.strictEqual(node.mempool.map.size, 2);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });

      it('all accounts in one tx', async () => {
        const tx = await wclient.execute('sendreveal', [name]);
        assert(tx);

        // Do not reset for next test, time to move on to REGISTER
      });
    });
  });

  describe('UPDATE', function() {
    const aliceResource = Resource.fromJSON({text: ['ALICE']});
    const bobResource = Resource.fromJSON({text: ['BOB']});

    it('should advance auction to REGISTER phase', async () => {
      await mineBlocks(network.names.revealPeriod);
      const ns = await node.chain.db.getNameStateByName(name);
      assert(ns.isClosed(node.chain.height, network));

      await wdb.rescan(0);

      // Alice is the winner
      const {hash, index} = ns.owner;
      assert(await wallet.txdb.hasCoinByAccount(0, hash, index));

      // ...not Bob (sanity check)
      assert(!await wallet.txdb.hasCoinByAccount(1, hash, index));
    });

    describe('Library methods', function() {
      it('reject from wrongly specified account', async () => {
        await assert.rejects(async () => {
          await wallet.sendUpdate(name, bobResource, {account: 'bob'});
        }, {
          name: 'Error',
          message: `Account does not own: "${name}".`
        });
      });

      it('send from correctly specified account', async () => {
        const tx = await wallet.sendUpdate(name, aliceResource, {account: 0});
        assert(tx);

        await wallet.abandon(tx.hash());

        assert.strictEqual(node.mempool.map.size, 1);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });

      it('send from correct account automatically', async () => {
        const tx = await wallet.sendUpdate(name, aliceResource);
        assert(tx);

        await wallet.abandon(tx.hash());

        assert.strictEqual(node.mempool.map.size, 1);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });
    });

    describe('HTTP API', function () {
      it('reject from wrongly specified account', async () => {
        await assert.rejects(async () => {
          await wclient.post(`wallet/${wallet.id}/update`, {
            name: name,
            data: bobResource,
            account: 'bob'
          });
        }, {
          name: 'Error',
          message: `Account does not own: "${name}".`
        });
      });

      it('send from correctly specified account', async () => {
        const tx = await wclient.post(`wallet/${wallet.id}/update`, {
            name: name,
            data: aliceResource,
            account: 'default'
          });
        assert(tx);

        await wallet.abandon(Buffer.from(tx.hash, 'hex'));

        assert.strictEqual(node.mempool.map.size, 1);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });

      it('send from correct account automatically', async () => {
        const tx = await wclient.post(`wallet/${wallet.id}/update`, {
            name: name,
            data: aliceResource
          });
        assert(tx);

        await wallet.abandon(Buffer.from(tx.hash, 'hex'));

        assert.strictEqual(node.mempool.map.size, 1);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });
    });

    describe('RPC API', function() {
      it('reject from wrongly specified account', async () => {
        await wclient.execute('selectwallet', [wallet.id]);

        await assert.rejects(async () => {
          await wclient.execute('sendupdate', [
            name,
            bobResource,
            'bob'
          ]);
        }, {
          name: 'Error',
          message: `Account does not own: "${name}".`
        });
      });

      it('send from correctly specified account', async () => {
        const tx = await wclient.execute('sendupdate', [
            name,
            aliceResource,
            'default'
          ]);
        assert(tx);

        await wallet.abandon(Buffer.from(tx.hash, 'hex'));

        assert.strictEqual(node.mempool.map.size, 1);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });

      it('send from correct account automatically', async () => {
        const tx = await wclient.execute('sendupdate', [
            name,
            aliceResource
          ]);
        assert(tx);

        await wallet.abandon(Buffer.from(tx.hash, 'hex'));

        assert.strictEqual(node.mempool.map.size, 1);
        await node.mempool.reset();
        assert.strictEqual(node.mempool.map.size, 0);
      });
    });
  });
});
