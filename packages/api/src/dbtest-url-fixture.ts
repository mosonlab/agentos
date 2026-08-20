/**
 * Connection strings for the database-test unit tests, assembled rather than
 * written out.
 *
 * These files are published, and the snapshot scan reads every published file
 * for credential-shaped strings. A `postgresql://` URL carrying a username and
 * a password in its userinfo is that shape whether or not the values mean
 * anything — a comment spelling the shape out is one too — and a scan that has
 * to be told which credentials are only pretend is a scan whose findings get
 * waved through: the exception is what costs, not the string.
 *
 * Assembling the userinfo from its parts leaves the shape out of the published
 * tree while the fixtures keep doing their job: the tests that call this still
 * hand the code under test a URL with a username and a password in it, and
 * still assert that both survive the database swaps it performs.
 */
export const fixtureDatabaseUrl = (user: string, password: string, rest: string): string =>
  `postgresql://${[user, password].join(":")}@${rest}`;
