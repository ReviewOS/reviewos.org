CREATE TYPE "org_members_role_type" AS ENUM ('owner', 'admin', 'member');
CREATE TYPE "team_members_role_type" AS ENUM ('maintainer', 'member');
CREATE TYPE "ssh_keys_key_type_type" AS ENUM ('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256');
