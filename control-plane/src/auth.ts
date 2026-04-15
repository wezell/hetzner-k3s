import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";

const devBypass = process.env.NEXTAUTH_BYPASS === "true";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    ...(devBypass
      ? [
          Credentials({
            credentials: { username: {} },
            async authorize() {
              return { id: "dev", name: "Dev User", email: "dev@local" };
            },
          }),
        ]
      : [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]),
  ],
  callbacks: {
    authorized({ auth }) {
      if (devBypass) return true;
      // Any authenticated user is authorized
      return !!auth;
    },
    session({ session, token }) {
      // Expose user identity fields to the client session
      if (token.sub) {
        session.user.id = token.sub;
      }
      if (token.email) {
        session.user.email = token.email as string;
      }
      if (token.name) {
        session.user.name = token.name as string;
      }
      if (token.picture) {
        session.user.image = token.picture as string;
      }
      return session;
    },
    jwt({ token, account, profile }) {
      // Persist Google profile data into the JWT on first sign-in
      if (account && profile) {
        token.email = profile.email;
        token.name = profile.name;
        token.picture = (profile as { picture?: string }).picture;
      }
      return token;
    },
  },
});
