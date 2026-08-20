import { route } from '@stacksjs/router'

/**
 * The documents somebody else reads to verify what this instance signed.
 *
 * **At the root, and that is not a preference.** A cloud provider registering
 * an identity provider fetches `https://host/.well-known/openid-configuration`
 * - the path is fixed by RFC 8414 and by every implementation of it, and a
 * document at `/api/.well-known/...` is one AWS, Google and Azure will never
 * ask for. So this file mounts with no prefix, like git's.
 *
 * Public and uncredentialed, because that is the point: whoever is checking a
 * signature has no account here and never will, and neither document contains
 * a secret - a public key is a thing you publish.
 */
route.get('/.well-known/jwks.json', 'Actions/Api/JwksAction')
route.get('/.well-known/openid-configuration', 'Actions/Api/OpenIdConfigurationAction')

/**
 * And the keys that verify the work this instance hands to its own runners,
 * kept apart from the identity set above so a verifier cannot mistake one
 * statement for the other.
 */
route.get('/.well-known/reviewos-step-keys.json', 'Actions/Api/StepKeysAction')

/**
 * The AT Protocol OAuth client metadata, which is also this instance's client
 * identity.
 *
 * Not under `.well-known` because the specification does not put it there: the
 * client id *is* the URL of this document, so it lives at a stable path of the
 * instance's choosing and an authorization server fetches it to learn what the
 * client claims. Public and secretless - a name, a redirect, and the one scope
 * this instance asks for.
 */
route.get('/atproto/client-metadata.json', 'Actions/Atproto/ClientMetadataAction')
