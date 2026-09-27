export type Locale = 'en' | 'vi';

export type TranslationDictionary = {
  tabs: {
    wallet: string;
    tasks: string;
    commands: string;
    policy: string;
    approvals: string;
    audit: string;
    docs: string;
  };
  topbar: {
    ready: string;
    offline: string;
    switchLanguage: string;
  };
  settings: {
    title: string;
    language: string;
    selectLanguage: string;
    english: string;
    vietnamese: string;
    close: string;
    logout: string;
  };
  boot: {
    serviceUnavailable: string;
    loading: string;
    signInRequired: string;
    signInDesc: string;
    signInBtn: string;
    connecting: string;
    installPhantom: string;
  };
  toasts: {
    confirmed: string;
    approvalRequired: string;
    denied: string;
    executionFailed: string;
    depositSent: string;
    policySaved: string;
    airdropRequested: string;
    seedClaimed: string;
  };
  agent: {
    title: string;
    availableBalance: string;
    dedicatedAddress: string;
    copyAddress: string;
    agentId: string;
    rpcError: string;
    masterFunder: string;
    claimSeed: string;
    seedClaimed: string;
    claimSeedTitle: string;
    claimSeedDoneTitle: string;
    deposit: string;
    depositTitle: string;
    airdrop: string;
    airdropRequesting: string;
    airdropTitle: string;
    faucet: string;
  };
  wallet: {
    title: string;
    disconnect: string;
    ready: string;
    notFound: string;
    installPhantom: string;
    connected: string;
    copyAddress: string;
    admin: string;
    owner: string;
    bound: string;
    unbound: string;
    connecting: string;
    connectWallet: string;
    availableBalance: string;
    connectToViewBalance: string;
    loadingBalance: string;
    rpcError: string;
  };
  funding: {
    title: string;
    initialSeedClaimed: string;
    seedCredited: string;
    claimSeed: string;
    claimSeedTitle: string;
    deposit: string;
    depositTitle: string;
    airdrop: string;
    airdropRequesting: string;
    airdropTitle: string;
    officialFaucet: string;
  };
  policy: {
    title: string;
    maxPerTx: string;
    recipients: string;
    noRecipients: string;
    remove: string;
    namePlaceholder: string;
    addressPlaceholder: string;
    addRecipient: string;
    useOwnerWallet: string;
    save: string;
    saving: string;
    unsaved: string;
  };
  console: {
    title: string;
    placeholderDefault: string;
    placeholderExample: string;
    run: string;
    running: string;
    autoHint: string;
    approvalHint: string;
    deniedHint: string;
    noPresets: string;
  };
  requests: {
    title: string;
    noRequests: string;
    showAll: string;
    showRecent: string;
    approve: string;
    waitingForWallet: string;
    connectOwnerWallet: string;
    expires: string;
    approvedBy: string;
    message: string;
    details: string;
    policyTag: string;
    modelsTag: string;
    balanceTag: string;
    signatureTag: string;
    explorer: string;
    statuses: {
      planned: string;
      auto_approved: string;
      pending_approval: string;
      approved: string;
      confirmed: string;
      failed: string;
      denied: string;
      expired: string;
    };
  };
  audit: {
    title: string;
    showLog: string;
    ciphertext: string;
    noEntries: string;
  };
};
