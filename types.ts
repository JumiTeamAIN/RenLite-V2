import { Timestamp } from 'firebase/firestore';

export enum View {
  LANDING = 'landing',
  STAFF_DASHBOARD = 'staff_dashboard',
  ADMIN_PANEL = 'admin_panel',
}

export type Role = 'guest' | 'staff' | 'admin';

export type LocationType =
  | 'room'
  | 'suite'
  | 'lobby'
  | 'pool'
  | 'restaurant'
  | 'bar'
  | 'fitness'
  | 'meeting'
  | 'public'
  | 'other';

export interface HotelLocation {
  id: string;
  code: string;
  label: string;
  type: LocationType;
  active: boolean;
}

export interface UserProfile {
  uid: string;
  email: string;
  hotelId?: string;
  role: Role;
}

export interface HotelConfig {
  id: string;
  name: string;
  persona: string;
  faqs: { question: string; answer: string }[];
  slas: {
    housekeeping: number;
    maintenance: number;
    front_desk: number;
  };
  locations?: HotelLocation[];
  emergencyPhone?: string;
}

export type SessionStatus =
  | 'active'
  | 'awaiting_human'
  | 'staff_controlled'
  | 'escalated'
  | 'completed';

export interface Session {
  id: string;
  guestUid: string;
  guestAccessStartedAt?: Timestamp;
  guestEndedAt?: Timestamp;
  roomMoveAt?: Timestamp;
  roomNumber?: string;
  locationId?: string;
  locationLabel?: string;
  locationType?: string;
  lastUpdatedAt: Timestamp;
  previewText: string;
  previewStaffText?: string;
  isUnread: boolean;
  status: SessionStatus;
  guestLanguage?: string;
  assignedStaffUid?: string;
  assignedStaffEmail?: string;
  escalationReason?: string;
  escalationSeverity?: 'high' | 'critical';
}

export interface Message {
  id: string;
  sender: 'guest' | 'ai' | 'staff' | 'system';
  text: string;
  staffText?: string;
  guestText?: string;
  originalLanguage?: string;
  translatedToLanguage?: string;
  timestamp: Timestamp;
  guestUid?: string;
  staffUid?: string;
}

export type RequestStatus =
  | 'pending'
  | 'acknowledged'
  | 'in_progress'
  | 'completed'
  | 'escalated'
  | 'reopened'
  | 'cancelled';

export interface Request {
  id: string;
  referenceCode?: string;
  sessionId: string;
  item: string;
  quantity?: number;
  category: string;
  department?: string;
  roomNumber: string;
  status: RequestStatus;
  createdAt: Timestamp;
  lastUpdated: Timestamp;
  acknowledgedAt?: Timestamp;
  completedAt?: Timestamp;
  description?: string;
  originalMessage?: string;
  priority?: 'normal' | 'high' | 'urgent';
  source?: 'ai' | 'structured' | 'staff';
  guestUid?: string;
}
