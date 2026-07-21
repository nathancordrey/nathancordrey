// Smoke test for the lobby skeleton: boots against the in-memory store,
// creates a guest session, validates it, and checks health. No DB required.

const PORT = 2578;
process.env.LOBBY_PORT = String(PORT);
delete process.env.DATABASE_URL; // force memory store

await import('../src/index.ts');
await new Promise((r) => setTimeout(r, 500));

const base = `http://localhost:${PORT}`;

async function main() {
  const health = await (await fetch(`${base}/health`)).json();
  console.log('health:', JSON.stringify(health));

  const guest = await (
    await fetch(`${base}/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nathan' }),
    })
  ).json();
  console.log('guest:', JSON.stringify(guest));

  const session = await (await fetch(`${base}/session?token=${guest.token}`)).json();
  console.log('session lookup:', JSON.stringify(session));

  const emptyName = await fetch(`${base}/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '' }),
  });
  console.log('empty name rejected:', emptyName.status === 400);

  const pass =
    health.ok === true &&
    health.store === 'memory' &&
    guest.name === '~Nathan' &&
    typeof guest.token === 'string' &&
    session.name === '~Nathan' &&
    emptyName.status === 400;

  console.log(pass ? 'LOBBY SMOKE PASS' : 'LOBBY SMOKE FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error('LOBBY SMOKE FAIL', error);
  process.exit(1);
});
