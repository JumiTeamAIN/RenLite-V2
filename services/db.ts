// Deprecated. RenLite v2 uses direct modular firebase imports in components/services 
// to ensure granular control over the data flow.

// Stubbing the service to prevent compilation errors in legacy components.
export const dbService: any = {
  getHotelConfig: async () => null,
  initHotel: async () => {},
  getSession: async () => null,
  createSession: async () => ({ id: 'stub-session' }),
  subscribeToSession: () => () => {},
  subscribeToMessages: () => () => {},
  sendMessage: async () => {},
  createRequest: async () => "stub-id",
  subscribeToHotelSessions: () => () => {},
  subscribeToRequests: () => () => {},
  updateRequestStatus: async () => {},
  updateHotelConfig: async () => {},
};