import {derived, writable} from "svelte/store"
import {cached, randomId, append, omit, equals, assoc} from "@welshman/lib"
import {withGetter} from "@welshman/store"
import {
  WrappedSigner,
  Nip46Broker,
  Nip46Signer,
  Nip07Signer,
  Nip01Signer,
  Nip55Signer,
  getPubkey,
  ISigner,
} from "@welshman/signer"

export enum SessionMethod {
  Nip01 = "nip01",
  Nip07 = "nip07",
  Nip46 = "nip46",
  Nip55 = "nip55",
  Pubkey = "pubkey",
}

export type SessionNip01 = {
  method: SessionMethod.Nip01
  pubkey: string
  secret: string
}

export type SessionNip07 = {
  method: SessionMethod.Nip07
  pubkey: string
}

export type SessionNip46 = {
  method: SessionMethod.Nip46
  pubkey: string
  secret: string
  handler: {
    pubkey: string
    relays: string[]
  }
}

export type SessionNip55 = {
  method: SessionMethod.Nip55
  pubkey: string
  signer: string
}

export type SessionPubkey = {
  method: SessionMethod.Pubkey
  pubkey: string
}

export type SessionAnyMethod =
  | SessionNip01
  | SessionNip07
  | SessionNip46
  | SessionNip55
  | SessionPubkey

export type Session = SessionAnyMethod & Record<string, any>

export const pubkey = withGetter(writable<string | undefined>(undefined))

export const sessions = withGetter(writable<Record<string, Session>>({}))

export const session = withGetter(
  derived([pubkey, sessions], ([$pubkey, $sessions]) => ($pubkey ? $sessions[$pubkey] : undefined)),
)

export const getSession = (pubkey: string) => sessions.get()[pubkey]

export const addSession = (session: Session) => {
  sessions.update(assoc(session.pubkey, session))
  pubkey.set(session.pubkey)
}

export const putSession = (session: Session) => {
  if (!equals(getSession(session.pubkey), session)) {
    sessions.update(assoc(session.pubkey, session))
  }
}

export const updateSession = (pubkey: string, f: (session: Session) => Session) =>
  putSession(f(getSession(pubkey)))

export const dropSession = (_pubkey: string) => {
  const $signer = getSigner.pop(getSession(_pubkey))

  if ($signer instanceof Nip46Signer) {
    $signer.broker.cleanup()
  }

  pubkey.update($pubkey => ($pubkey === _pubkey ? undefined : $pubkey))
  sessions.update($sessions => omit([_pubkey], $sessions))
}

export const clearSessions = () => {
  for (const pubkey of Object.keys(sessions.get())) {
    dropSession(pubkey)
  }
}

// Session factories

export const makeNip01Session = (secret: string): SessionNip01 => ({
  method: SessionMethod.Nip01,
  secret,
  pubkey: getPubkey(secret),
})

export const makeNip07Session = (pubkey: string): SessionNip07 => ({
  method: SessionMethod.Nip07,
  pubkey,
})

export const makeNip46Session = (
  pubkey: string,
  clientSecret: string,
  signerPubkey: string,
  relays: string[],
): SessionNip46 => ({
  method: SessionMethod.Nip46,
  pubkey,
  secret: clientSecret,
  handler: {pubkey: signerPubkey, relays},
})

export const makeNip55Session = (pubkey: string, signer: string): SessionNip55 => ({
  method: SessionMethod.Nip55,
  pubkey,
  signer,
})

export const makePubkeySession = (pubkey: string): SessionPubkey => ({
  method: SessionMethod.Pubkey,
  pubkey,
})

// Type guards

export const isNip01Session = (session?: Session): session is SessionNip01 =>
  session?.method === SessionMethod.Nip01

export const isNip07Session = (session?: Session): session is SessionNip07 =>
  session?.method === SessionMethod.Nip07

export const isNip46Session = (session?: Session): session is SessionNip46 =>
  session?.method === SessionMethod.Nip46

export const isNip55Session = (session?: Session): session is SessionNip55 =>
  session?.method === SessionMethod.Nip55

export const isPubkeySession = (session?: Session): session is SessionPubkey =>
  session?.method === SessionMethod.Pubkey

// Login utilities

export const loginWithNip01 = (secret: string) => addSession(makeNip01Session(secret))

export const loginWithNip07 = (pubkey: string) => addSession(makeNip07Session(pubkey))

export const loginWithNip46 = (
  pubkey: string,
  clientSecret: string,
  signerPubkey: string,
  relays: string[],
) => addSession(makeNip46Session(pubkey, clientSecret, signerPubkey, relays))

export const loginWithNip55 = (pubkey: string, signer: string) =>
  addSession(makeNip55Session(pubkey, signer))

export const loginWithPubkey = (pubkey: string) => addSession(makePubkeySession(pubkey))

// Other stuff

export const nip46Perms = "sign_event:22242,nip04_encrypt,nip04_decrypt,nip44_encrypt,nip44_decrypt"

export enum SignerLogEntryStatus {
  Pending = "pending",
  Success = "success",
  Failure = "failure",
}

export type SignerLogEntry = {
  id: string
  method: string
  status: SignerLogEntryStatus
  duration: number
}

export const signerLog = withGetter(writable<SignerLogEntry[]>([]))

export const wrapSigner = (signer: ISigner) =>
  new WrappedSigner(signer, async <T>(method: string, thunk: () => Promise<T>) => {
    const id = randomId()
    const now = Date.now()

    signerLog.update(log =>
      append({id, method, status: SignerLogEntryStatus.Pending, duration: 0}, log),
    )

    try {
      const result = await thunk()

      signerLog.update(log =>
        log.map(x =>
          x.id === id
            ? {...x, status: SignerLogEntryStatus.Success, duration: Date.now() - now}
            : x,
        ),
      )

      return result
    } catch (error: any) {
      signerLog.update(log =>
        log.map(x =>
          x.id === id
            ? {...x, status: SignerLogEntryStatus.Failure, duration: Date.now() - now}
            : x,
        ),
      )

      throw error
    }
  })

export const getSigner = cached({
  maxSize: 100,
  getKey: ([session]: [Session | undefined]) => `${session?.method}:${session?.pubkey}`,
  getValue: ([session]: [Session | undefined]) => {
    if (isNip07Session(session)) return wrapSigner(new Nip07Signer())
    if (isNip01Session(session)) return wrapSigner(new Nip01Signer(session.secret))
    if (isNip55Session(session)) return wrapSigner(new Nip55Signer(session.signer))
    if (isNip46Session(session)) {
      const {
        secret: clientSecret,
        handler: {relays, pubkey: signerPubkey},
      } = session
      const broker = new Nip46Broker({clientSecret, signerPubkey, relays})
      const signer = new Nip46Signer(broker)

      return wrapSigner(signer)
    }
  },
})

export const signer = withGetter(derived(session, getSigner))

export const nip44EncryptToSelf = (payload: string) => {
  const $pubkey = pubkey.get()
  const $signer = signer.get()

  if (!$signer) {
    throw new Error("Unable to encrypt to self without valid signer")
  }

  return $signer.nip44.encrypt($pubkey!, payload)
}
