import React, { useState, useEffect } from 'react';
import { 
  onAuthStateChanged, 
  User as FirebaseUser,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updatePassword
} from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  updateDoc,
  deleteDoc,
  Timestamp,
  orderBy,
  getDocFromServer,
  serverTimestamp
} from 'firebase/firestore';
import { 
  LogOut, 
  Calendar, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Plus, 
  User, 
  ShieldCheck,
  FileText,
  AlertCircle,
  ChevronRight,
  Edit,
  Trash2,
  Settings,
  Key,
  RefreshCw
} from 'lucide-react';
import { format, differenceInDays, addDays, isBefore, startOfDay } from 'date-fns';
import { auth, db, loginWithEmail, registerUser, logout } from './firebase';
import { cn } from './lib/utils';

// --- Types ---

type LeaveType = 'CL' | 'PL' | 'SL' | 'ML' | 'PaL' | 'CompOff' | 'WPL' | 'Absent';

interface LeaveBalances {
  CL: number;
  PL: number;
  SL: number;
  ML: number;
  PaL: number;
  CompOff: number;
}

interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  role: 'employee' | 'hr';
  designation?: string;
  salary?: number;
  dob?: string;
  doj?: string;
  balances: LeaveBalances;
  lastAccrualUpdate?: string;
}

interface EncashmentRequest {
  id: string;
  uid: string;
  employeeName: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: any;
}

interface LeaveRequest {
  id: string;
  uid: string;
  employeeName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  hrComment?: string;
  createdAt: any;
  isIndiscipline?: boolean;
  isHalfDay?: boolean;
  changeRequest?: {
    requestedType: LeaveType;
    reason: string;
    status: 'pending' | 'approved' | 'rejected';
    hrComment?: string;
  };
}

const LEAVE_TYPES: { label: string; value: LeaveType; color: string }[] = [
  { label: 'Casual Leave (CL)', value: 'CL', color: 'bg-blue-100 text-blue-700' },
  { label: 'Privilege Leave (PL)', value: 'PL', color: 'bg-green-100 text-green-700' },
  { label: 'Sick Leave (SL)', value: 'SL', color: 'bg-red-100 text-red-700' },
  { label: 'Maternity Leave (ML)', value: 'ML', color: 'bg-purple-100 text-purple-700' },
  { label: 'Paternity Leave (PaL)', value: 'PaL', color: 'bg-indigo-100 text-indigo-700' },
  { label: 'Compensatory Off', value: 'CompOff', color: 'bg-orange-100 text-orange-700' },
  { label: 'Without Pay Leave (WPL)', value: 'WPL', color: 'bg-gray-100 text-gray-700' },
  { label: 'Absent (Indiscipline)', value: 'Absent', color: 'bg-red-600 text-white' },
];

const INITIAL_BALANCES: LeaveBalances = {
  CL: 7,
  PL: 0, // Starts at 0, accrued monthly
  SL: 7,
  ML: 182, // 26 weeks
  PaL: 3,
  CompOff: 0,
};

// --- Utilities ---

function calculateAccruedPL(doj: string, lastUpdate?: string): { additionalPL: number; nextUpdate: string } {
  if (!doj) return { additionalPL: 0, nextUpdate: '' };
  
  const now = new Date();
  const currentMonthKey = `${now.getMonth()}-${now.getFullYear()}`;
  
  if (lastUpdate === currentMonthKey) {
    return { additionalPL: 0, nextUpdate: currentMonthKey };
  }

  const joinDate = new Date(doj);
  const currentYear = now.getFullYear();
  
  // Start date for this year's accrual
  let startDate: Date;
  if (lastUpdate) {
    const [lastMonth, lastYear] = lastUpdate.split('-').map(Number);
    // Start from the month after the last update
    startDate = new Date(lastYear, lastMonth + 1, 1);
  } else {
    // If no last update, start from Jan 1st of current year or DOJ
    startDate = new Date(currentYear, 0, 1);
    if (joinDate > startDate) {
      startDate = joinDate;
    }
  }

  // Calculate months between startDate and now
  // If startDate is Jan 1st and now is March 28th, monthsDiff = 2 (Jan, Feb)
  let monthsDiff = (now.getFullYear() - startDate.getFullYear()) * 12 + (now.getMonth() - startDate.getMonth());
  
  if (monthsDiff < 0) monthsDiff = 0;

  return { 
    additionalPL: monthsDiff * 1.5, 
    nextUpdate: currentMonthKey 
  };
}

// --- Components ---

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [allRequests, setAllRequests] = useState<LeaveRequest[]>([]);
  const [encashmentRequests, setEncashmentRequests] = useState<EncashmentRequest[]>([]);
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showEncashModal, setShowEncashModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showAddCompOffModal, setShowAddCompOffModal] = useState(false);
  const [showMarkAbsentModal, setShowMarkAbsentModal] = useState(false);
  const [selectedUserForCompOff, setSelectedUserForCompOff] = useState<UserProfile | null>(null);
  const [selectedUserForAbsent, setSelectedUserForAbsent] = useState<UserProfile | null>(null);
  const [showChangeRequestModal, setShowChangeRequestModal] = useState(false);
  const [selectedRequestForChange, setSelectedRequestForChange] = useState<LeaveRequest | null>(null);
  const [showChangeAbsentModal, setShowChangeAbsentModal] = useState(false);
  const [selectedAbsentRequest, setSelectedAbsentRequest] = useState<LeaveRequest | null>(null);
  const [viewMode, setViewMode] = useState<'dashboard' | 'calendar' | 'users'>('dashboard');

  // Auth & Profile Setup
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        // Test connection
        try {
          await getDocFromServer(doc(db, 'test', 'connection'));
        } catch (e) {}

        const userRef = doc(db, 'users', firebaseUser.uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
          const data = userSnap.data() as UserProfile;
          // Auto-upgrade to HR if email matches
          if (data.email === 'info.rosium@gmail.com' && data.role !== 'hr') {
            await updateDoc(userRef, { role: 'hr' });
            data.role = 'hr';
          }

          // Sync PL Accrual
          if (data.doj) {
            const { additionalPL, nextUpdate } = calculateAccruedPL(data.doj, data.lastAccrualUpdate);
            if (additionalPL > 0 || data.lastAccrualUpdate !== nextUpdate) {
              const newPL = (data.balances.PL || 0) + additionalPL;
              await updateDoc(userRef, {
                'balances.PL': newPL,
                'lastAccrualUpdate': nextUpdate
              });
              data.balances.PL = newPL;
              data.lastAccrualUpdate = nextUpdate;
            }
          }

          setProfile(data);
          // Check if profile is incomplete
          if (!data.designation || !data.dob || !data.doj) {
            setShowProfileModal(true);
          }
        } else {
          // Create new profile
          const isHR = firebaseUser.email === 'info.rosium@gmail.com';
          const now = new Date();
          const currentMonthKey = `${now.getMonth()}-${now.getFullYear()}`;
          
          const newProfile: UserProfile = {
            uid: firebaseUser.uid,
            email: firebaseUser.email || '',
            displayName: firebaseUser.displayName || (isHR ? 'HR Admin' : 'New Employee'),
            photoURL: firebaseUser.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(firebaseUser.email || 'User')}&background=random`,
            role: isHR ? 'hr' : 'employee',
            balances: { ...INITIAL_BALANCES },
            lastAccrualUpdate: currentMonthKey
          };
          await setDoc(userRef, newProfile);
          setProfile(newProfile);
          setShowProfileModal(true);
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // Real-time Requests
  useEffect(() => {
    if (!profile) return;

    let q;
    if (profile.role === 'hr') {
      q = query(collection(db, 'leaveRequests'), orderBy('createdAt', 'desc'));
    } else {
      q = query(
        collection(db, 'leaveRequests'), 
        where('uid', '==', profile.uid),
        orderBy('createdAt', 'desc')
      );
    }

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as LeaveRequest));
      if (profile.role === 'hr') {
        setAllRequests(data);
      } else {
        setRequests(data);
      }
    }, (error) => {
      console.error("Firestore Error: ", error);
    });

    // Fetch encashment requests
    const encQuery = profile.role === 'hr' 
      ? query(collection(db, 'encashmentRequests'), orderBy('createdAt', 'desc'))
      : query(collection(db, 'encashmentRequests'), where('uid', '==', profile.uid), orderBy('createdAt', 'desc'));

    const encUnsubscribe = onSnapshot(encQuery, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as EncashmentRequest));
      setEncashmentRequests(data);
    });

    return () => {
      unsubscribe();
      encUnsubscribe();
    };
  }, [profile]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-600"></div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-orange-600 p-2 rounded-lg">
            <Calendar className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900 leading-tight">Rosium Leave Manager</h1>
            <p className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Corporate Portal</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {profile?.role === 'hr' && (
            <div className="flex bg-gray-100 p-1 rounded-xl mr-4">
              <button 
                onClick={() => setViewMode('dashboard')}
                className={cn("px-4 py-1.5 rounded-lg text-sm font-bold transition-all", 
                  viewMode === 'dashboard' ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                )}
              >
                Dashboard
              </button>
              <button 
                onClick={() => setViewMode('calendar')}
                className={cn("px-4 py-1.5 rounded-lg text-sm font-bold transition-all", 
                  viewMode === 'calendar' ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                )}
              >
                Calendar
              </button>
              <button 
                onClick={() => setViewMode('users')}
                className={cn("px-4 py-1.5 rounded-lg text-sm font-bold transition-all", 
                  viewMode === 'users' ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                )}
              >
                Manage Users
              </button>
            </div>
          )}
          <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-100 rounded-full">
            <img src={user.photoURL || null} className="w-8 h-8 rounded-full border border-white" alt="User" />
            <div className="hidden sm:block">
              <p className="text-sm font-bold text-gray-800 leading-none">{profile?.displayName}</p>
              <p className="text-[10px] text-gray-500 uppercase font-bold mt-1">{profile?.role}</p>
            </div>
          </div>
          <button 
            onClick={() => setShowSettingsModal(true)}
            className="p-2 text-gray-400 hover:text-blue-600 transition-colors"
            title="Settings"
          >
            <Settings className="w-5 h-5" />
          </button>
          <button 
            onClick={logout}
            className="p-2 text-gray-400 hover:text-red-600 transition-colors"
            title="Logout"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {profile?.role === 'employee' ? (
          <EmployeeDashboard 
            profile={profile} 
            requests={requests} 
            onApply={() => setShowApplyModal(true)} 
            onEncash={() => setShowEncashModal(true)}
            onApplyChangeRequest={(req) => {
              setSelectedRequestForChange(req);
              setShowChangeRequestModal(true);
            }}
          />
        ) : (
          viewMode === 'dashboard' ? (
            <HRDashboard 
              profile={profile} 
              allRequests={allRequests} 
              encashmentRequests={encashmentRequests}
              onChangeAbsent={(req) => {
                setSelectedAbsentRequest(req);
                setShowChangeAbsentModal(true);
              }}
            />
          ) : viewMode === 'calendar' ? (
            <div className="lg:col-span-12">
              <HRCalendar allRequests={allRequests} />
            </div>
          ) : (
            <div className="lg:col-span-12">
              <UserManagement 
                setSelectedUserForCompOff={setSelectedUserForCompOff}
                setShowAddCompOffModal={setShowAddCompOffModal}
                setSelectedUserForAbsent={setSelectedUserForAbsent}
                setShowMarkAbsentModal={setShowMarkAbsentModal}
              />
            </div>
          )
        )}
      </main>

      {showApplyModal && (
        <ApplyLeaveModal 
          profile={profile!} 
          onClose={() => setShowApplyModal(false)} 
        />
      )}

      {showEncashModal && (
        <EncashLeaveModal 
          profile={profile!} 
          onClose={() => setShowEncashModal(false)} 
        />
      )}

      {showProfileModal && (
        <CompleteProfileModal 
          profile={profile!} 
          onComplete={(updatedProfile) => {
            setProfile(updatedProfile);
            setShowProfileModal(false);
          }} 
        />
      )}

      {showSettingsModal && (
        <SettingsModal 
          onClose={() => setShowSettingsModal(false)} 
        />
      )}

      {showAddCompOffModal && selectedUserForCompOff && profile && (
        <AddCompOffModal 
          targetUser={selectedUserForCompOff}
          hrUser={profile}
          onClose={() => {
            setShowAddCompOffModal(false);
            setSelectedUserForCompOff(null);
          }} 
        />
      )}

      {showMarkAbsentModal && selectedUserForAbsent && profile && (
        <MarkAbsentModal 
          targetUser={selectedUserForAbsent}
          hrUser={profile}
          onClose={() => {
            setShowMarkAbsentModal(false);
            setSelectedUserForAbsent(null);
          }} 
        />
      )}

      {showChangeRequestModal && selectedRequestForChange && (
        <ChangeRequestModal 
          request={selectedRequestForChange}
          onClose={() => {
            setShowChangeRequestModal(false);
            setSelectedRequestForChange(null);
          }}
        />
      )}

      {showChangeAbsentModal && selectedAbsentRequest && (
        <ChangeAbsentModal 
          request={selectedAbsentRequest}
          onClose={() => {
            setShowChangeAbsentModal(false);
            setSelectedAbsentRequest(null);
          }}
        />
      )}
    </div>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      if (auth.currentUser) {
        await updatePassword(auth.currentUser, newPassword);
        setSuccess("Password updated successfully!");
        setNewPassword('');
        setConfirmPassword('');
      }
    } catch (err: any) {
      console.error("Error updating password:", err);
      if (err.code === 'auth/requires-recent-login') {
        setError("Please logout and login again to change your password for security reasons.");
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 z-50">
      <div className="bg-white rounded-[32px] w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="bg-gray-900 p-8 text-white flex items-center justify-between">
          <div>
            <h3 className="text-2xl font-bold">Account Settings</h3>
            <p className="text-gray-400 text-sm mt-1">Change your password</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl transition-colors">
            <XCircle className="w-6 h-6" />
          </button>
        </div>
        
        <form onSubmit={handleUpdatePassword} className="p-8 space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">New Password</label>
              <div className="relative">
                <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input 
                  type="password" 
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-12 pr-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="••••••••"
                  required
                  minLength={6}
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Confirm Password</label>
              <div className="relative">
                <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input 
                  type="password" 
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-12 pr-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="••••••••"
                  required
                  minLength={6}
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="p-4 bg-red-50 text-red-600 rounded-xl text-sm font-bold flex items-center gap-3">
              <AlertCircle className="w-5 h-5" />
              {error}
            </div>
          )}

          {success && (
            <div className="p-4 bg-green-50 text-green-600 rounded-xl text-sm font-bold flex items-center gap-3">
              <CheckCircle className="w-5 h-5" />
              {success}
            </div>
          )}

          <button 
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-xl shadow-blue-600/20 flex items-center justify-center gap-2"
          >
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  );
}

function AddCompOffModal({ targetUser, hrUser, onClose }: { targetUser: UserProfile; hrUser: UserProfile; onClose: () => void }) {
  const [workedDate, setWorkedDate] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleAddCompOff = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      // 1. Create a record
      await addDoc(collection(db, 'compOffRecords'), {
        uid: targetUser.uid,
        employeeName: targetUser.displayName,
        workedDate,
        reason,
        addedBy: hrUser.uid,
        createdAt: new Date().toISOString()
      });

      // 2. Update user balance
      const userRef = doc(db, 'users', targetUser.uid);
      const currentCompOff = targetUser.balances.CompOff || 0;
      
      await updateDoc(userRef, {
        'balances.CompOff': currentCompOff + 1
      });

      onClose();
    } catch (err: any) {
      console.error("Error adding CompOff:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 z-50">
      <div className="bg-white rounded-[32px] w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="bg-orange-600 p-8 text-white flex items-center justify-between">
          <div>
            <h3 className="text-2xl font-bold">Add CompOff</h3>
            <p className="text-orange-100 text-sm mt-1">For {targetUser.displayName}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl transition-colors">
            <XCircle className="w-6 h-6" />
          </button>
        </div>
        
        <form onSubmit={handleAddCompOff} className="p-8 space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Worked Date (Weekly Off)</label>
              <input 
                type="date" 
                value={workedDate}
                onChange={(e) => setWorkedDate(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Reason / Remarks</label>
              <textarea 
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none min-h-[100px]"
                placeholder="Worked on Sunday for project deadline"
                required
              />
            </div>
          </div>

          {error && (
            <div className="p-4 bg-red-50 text-red-600 rounded-xl text-sm font-bold flex items-center gap-3">
              <AlertCircle className="w-5 h-5" />
              {error}
            </div>
          )}

          <button 
            type="submit"
            disabled={loading}
            className="w-full bg-orange-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-orange-700 transition-all shadow-xl shadow-orange-600/20 flex items-center justify-center gap-2"
          >
            {loading ? 'Adding...' : 'Add 1 Day Balance'}
          </button>
        </form>
      </div>
    </div>
  );
}

function MarkAbsentModal({ targetUser, hrUser, onClose }: { targetUser: UserProfile; hrUser: UserProfile; onClose: () => void }) {
  const [absentDate, setAbsentDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [reason, setReason] = useState('Uninformed absence');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleMarkAbsent = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      // 1. Create a leave request with 'Absent' type and 'approved' status
      await addDoc(collection(db, 'leaveRequests'), {
        uid: targetUser.uid,
        employeeName: targetUser.displayName,
        leaveType: 'Absent',
        startDate: absentDate,
        endDate: absentDate,
        days: 1,
        reason: reason,
        status: 'approved',
        hrComment: `Marked absent by HR (${hrUser.displayName})`,
        isIndiscipline: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      onClose();
    } catch (err: any) {
      console.error("Error marking absent:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 z-50">
      <div className="bg-white rounded-[32px] w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="bg-red-600 p-8 text-white flex items-center justify-between">
          <div>
            <h3 className="text-2xl font-bold">Mark Absent</h3>
            <p className="text-red-100 text-sm mt-1">For {targetUser.displayName}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl transition-colors">
            <XCircle className="w-6 h-6" />
          </button>
        </div>
        
        <form onSubmit={handleMarkAbsent} className="p-8 space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Date of Absence</label>
              <input 
                type="date" 
                value={absentDate}
                onChange={(e) => setAbsentDate(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-red-500 outline-none"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Reason / Remarks</label>
              <textarea 
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-red-500 outline-none min-h-[100px]"
                placeholder="Uninformed absence"
                required
              />
            </div>
          </div>

          {error && (
            <div className="p-4 bg-red-50 text-red-600 rounded-xl text-sm font-bold flex items-center gap-3">
              <AlertCircle className="w-5 h-5" />
              {error}
            </div>
          )}

          <button 
            type="submit"
            disabled={loading}
            className="w-full bg-red-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-red-700 transition-all shadow-xl shadow-red-600/20 flex items-center justify-center gap-2"
          >
            {loading ? 'Marking...' : 'Mark as Absent'}
          </button>
        </form>
      </div>
    </div>
  );
}

// --- Sub-Components ---

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isSettingUpHR, setIsSettingUpHR] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await loginWithEmail(email, password);
    } catch (err: any) {
      console.error("Login error:", err);
      const isHREmail = email === 'info.rosium@gmail.com';
      
      if (err.code === 'auth/operation-not-allowed') {
        setError("Email/Password login is not enabled in your Firebase Console. Please enable it under Authentication > Sign-in method.");
      } else if (isHREmail && (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/invalid-login-credentials')) {
        // Some Firebase versions return invalid-credential for non-existent users
        setIsSettingUpHR(true);
        setError("HR account not found or credentials invalid. If this is your first time, click 'Initialize HR Account' below.");
      } else {
        setError(err.message || "Invalid email or password");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSetupHR = async () => {
    setLoading(true);
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F2ED] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-[32px] shadow-2xl shadow-orange-900/10 p-10 border border-gray-100">
        <div className="bg-orange-600 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-lg shadow-orange-600/20">
          <Calendar className="text-white w-8 h-8" />
        </div>
        <h2 className="text-3xl font-serif font-bold text-gray-900 mb-2 text-center">Rosium Leave Manager</h2>
        <p className="text-gray-500 mb-8 text-center">Corporate Portal Login</p>
        
        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Email Address</label>
              {email === 'info.rosium@gmail.com' && !isSettingUpHR && (
                <button 
                  type="button"
                  onClick={() => setIsSettingUpHR(true)}
                  className="text-[10px] font-bold text-orange-600 uppercase tracking-widest hover:underline"
                >
                  Setup HR?
                </button>
              )}
            </div>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
              placeholder="name@rosium.com"
              required
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Password</label>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
              placeholder="••••••••"
              required
            />
          </div>

          {error && (
            <div className="p-3 bg-red-50 text-red-600 rounded-xl text-xs font-bold flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          {isSettingUpHR ? (
            <button 
              type="button"
              onClick={handleSetupHR}
              disabled={loading}
              className="w-full bg-orange-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-orange-700 transition-all shadow-xl shadow-orange-600/20"
            >
              {loading ? 'Setting up...' : 'Initialize HR Account'}
            </button>
          ) : (
            <button 
              type="submit"
              disabled={loading}
              className="w-full bg-gray-900 text-white py-4 px-6 rounded-2xl font-bold hover:bg-black transition-all shadow-xl shadow-gray-900/20"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          )}
        </form>
        
        <div className="mt-10 pt-8 border-t border-gray-100 text-center">
          <p className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Authorized Access Only</p>
        </div>
      </div>
    </div>
  );
}

function EmployeeDashboard({ profile, requests, onApply, onEncash, onApplyChangeRequest }: { profile: UserProfile; requests: LeaveRequest[]; onApply: () => void; onEncash: () => void; onApplyChangeRequest: (req: LeaveRequest) => void }) {
  const isJanuary = new Date().getMonth() === 0;
  
  return (
    <>
      {/* Left Column: Balances & Quick Actions */}
      <div className="lg:col-span-4 space-y-6">
        <div className="bg-white rounded-3xl p-6 border border-gray-200 shadow-sm">
          <div className="flex items-center gap-4 mb-6 pb-6 border-b border-gray-100">
            <div className="w-16 h-16 rounded-2xl bg-orange-100 flex items-center justify-center text-orange-600 font-bold text-2xl">
              {profile.displayName.charAt(0)}
            </div>
            <div>
              <h3 className="font-bold text-gray-900 text-lg">{profile.displayName}</h3>
              <p className="text-sm text-gray-500 font-medium">{profile.designation || 'Employee'}</p>
              <div className="flex flex-col gap-1 mt-2">
                <p className="text-[10px] text-gray-400 uppercase font-bold">Joined: {profile.doj ? format(new Date(profile.doj), 'MMM dd, yyyy') : 'N/A'}</p>
                <p className="text-[10px] text-gray-400 uppercase font-bold">DOB: {profile.dob ? format(new Date(profile.dob), 'MMM dd, yyyy') : 'N/A'}</p>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between mb-6">
            <h3 className="font-bold text-gray-900 text-lg">Leave Balances</h3>
            <div className="flex gap-2">
              {isJanuary && profile.balances.PL > 0 && (
                <button 
                  onClick={onEncash}
                  className="bg-gray-100 text-gray-700 px-3 py-2 rounded-xl text-xs font-bold hover:bg-gray-200 transition-all"
                  title="Encash PL/EL"
                >
                  Encash
                </button>
              )}
              <button 
                onClick={onApply}
                className="bg-orange-600 text-white p-2 rounded-xl hover:bg-orange-700 transition-all shadow-lg shadow-orange-600/20"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>
          </div>
          
          <div className="space-y-4">
            {Object.entries(profile.balances).map(([key, val]) => (
              <div key={key} className="flex items-center justify-between p-3 bg-gray-50 rounded-2xl border border-gray-100">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center shadow-sm border border-gray-100">
                    <span className="font-bold text-xs text-orange-600">{key}</span>
                  </div>
                  <span className="text-sm font-semibold text-gray-700">{key === 'CompOff' ? 'Comp Off' : key}</span>
                </div>
                <span className="text-lg font-bold text-gray-900">{val} <span className="text-[10px] text-gray-400 uppercase">Days</span></span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-gray-900 rounded-3xl p-6 text-white shadow-xl shadow-gray-900/20">
          <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
            <FileText className="w-5 h-5 text-orange-400" />
            Policy Quick View
          </h3>
          <ul className="space-y-3 text-sm text-gray-300">
            <li className="flex gap-2">
              <span className="text-orange-400 font-bold">•</span>
              Apply 3 days in advance
            </li>
            <li className="flex gap-2">
              <span className="text-orange-400 font-bold">•</span>
              CL: Max 3 days at a stretch
            </li>
            <li className="flex gap-2">
              <span className="text-orange-400 font-bold">•</span>
              SL: Certificate needed if {'>'} 2 days
            </li>
          </ul>
        </div>
      </div>

      {/* Right Column: History */}
      <div className="lg:col-span-8 space-y-6">
        <div className="bg-white rounded-3xl p-8 border border-gray-200 shadow-sm min-h-[600px]">
          <h3 className="text-2xl font-bold text-gray-900 mb-8">My Leave History</h3>
          
          {requests.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-96 text-gray-400">
              <Clock className="w-16 h-16 mb-4 opacity-20" />
              <p className="text-lg font-medium">No leave requests yet</p>
              <button onClick={onApply} className="mt-4 text-orange-600 font-bold hover:underline">Apply for your first leave</button>
            </div>
          ) : (
            <div className="space-y-4">
              {requests.map(req => (
                <div key={req.id} className="group p-5 bg-white border border-gray-100 rounded-2xl hover:border-orange-200 hover:shadow-md transition-all">
                  <div className="flex items-start justify-between">
                    <div className="flex gap-4">
                      <div className={cn("px-3 py-1 rounded-full text-[10px] font-bold uppercase h-fit flex items-center gap-1", 
                        LEAVE_TYPES.find(t => t.value === req.leaveType)?.color
                      )}>
                        {req.leaveType}
                        {req.isIndiscipline && (
                          <span className="bg-white/20 px-1 rounded text-[8px]">Indiscipline</span>
                        )}
                      </div>
                      <div>
                        <h4 className="font-bold text-gray-900">
                          {format(new Date(req.startDate), 'MMM dd')} - {format(new Date(req.endDate), 'MMM dd, yyyy')}
                        </h4>
                        <p className="text-sm text-gray-500 mt-1 line-clamp-1">{req.reason}</p>
                        <div className="flex items-center gap-4 mt-3">
                          <span className="text-xs font-bold text-gray-400 uppercase tracking-tighter flex items-center gap-1">
                            <Clock className="w-3 h-3" /> {req.days} Days
                          </span>
                          <span className="text-xs font-bold text-gray-400 uppercase tracking-tighter">
                            Applied {format(req.createdAt?.toDate() || new Date(), 'MMM dd')}
                          </span>
                        </div>
                        {req.leaveType === 'Absent' && !req.changeRequest && (
                          <button 
                            onClick={() => onApplyChangeRequest(req)}
                            className="mt-3 text-[10px] font-bold text-orange-600 uppercase tracking-widest hover:underline flex items-center gap-1"
                          >
                            <RefreshCw className="w-3 h-3" /> Request to Change Status
                          </button>
                        )}
                        {req.changeRequest && (
                          <div className="mt-3 p-3 bg-orange-50 rounded-xl border border-orange-100">
                            <p className="text-[10px] font-bold text-orange-600 uppercase tracking-widest mb-1">Change Request: {req.changeRequest.status}</p>
                            <p className="text-xs text-gray-600">Requested: {req.changeRequest.requestedType}</p>
                            <p className="text-xs text-gray-500 italic mt-1">"{req.changeRequest.reason}"</p>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <StatusBadge status={req.status} />
                      {req.hrComment && (
                        <p className="text-[10px] text-gray-400 italic max-w-[150px] text-right">"{req.hrComment}"</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function HRDashboard({ profile, allRequests, encashmentRequests, onChangeAbsent }: { profile: UserProfile; allRequests: LeaveRequest[]; encashmentRequests: EncashmentRequest[]; onChangeAbsent: (req: LeaveRequest) => void }) {
  const [activeTab, setActiveTab] = useState<'leaves' | 'salary'>('leaves');
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [showPastLeaveModal, setShowPastLeaveModal] = useState(false);

  useEffect(() => {
    const q = query(collection(db, 'users'), orderBy('displayName', 'asc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setUsers(snapshot.docs.map(doc => doc.data() as UserProfile));
    });
    return () => unsubscribe();
  }, []);

  const pending = allRequests.filter(r => r.status === 'pending');
  const history = allRequests.filter(r => r.status !== 'pending');
  const pendingEncash = encashmentRequests.filter(r => r.status === 'pending');
  const changeRequests = allRequests.filter(r => r.changeRequest && r.changeRequest.status === 'pending');

  const handleAction = async (requestId: string, status: 'approved' | 'rejected') => {
    const comment = prompt(`Add a comment for this ${status} (optional):`);
    const req = allRequests.find(r => r.id === requestId);
    if (!req) return;

    try {
      await updateDoc(doc(db, 'leaveRequests', requestId), {
        status,
        hrComment: comment || '',
        updatedAt: Timestamp.now()
      });

      // If approved, deduct from balance (skip for WPL and Absent)
      if (status === 'approved' && req.leaveType !== 'WPL' && req.leaveType !== 'Absent') {
        const userRef = doc(db, 'users', req.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          const userData = userSnap.data() as UserProfile;
          const currentBalance = userData.balances[req.leaveType as keyof LeaveBalances] || 0;
          await updateDoc(userRef, {
            [`balances.${req.leaveType}`]: Math.max(0, currentBalance - req.days)
          });
        }
      }
    } catch (e) {
      console.error("Error updating request:", e);
    }
  };

  const handleEncashAction = async (requestId: string, status: 'approved' | 'rejected') => {
    const req = encashmentRequests.find(r => r.id === requestId);
    if (!req) return;

    try {
      await updateDoc(doc(db, 'encashmentRequests', requestId), {
        status,
        updatedAt: Timestamp.now()
      });

      if (status === 'approved') {
        const userRef = doc(db, 'users', req.uid);
        await updateDoc(userRef, {
          'balances.PL': 0 // As per user request: "show balance zero"
        });
      }
    } catch (e) {
      console.error("Error updating encashment:", e);
    }
  };

  return (
    <div className="lg:col-span-12 space-y-8">
      {/* Tabs */}
      <div className="flex items-center gap-2 bg-white p-2 rounded-2xl border border-gray-200 w-fit">
        <button 
          onClick={() => setActiveTab('leaves')}
          className={cn("px-6 py-2 rounded-xl font-bold text-sm transition-all", 
            activeTab === 'leaves' ? "bg-gray-900 text-white shadow-lg shadow-gray-900/20" : "text-gray-500 hover:bg-gray-50"
          )}
        >
          Leave Management
        </button>
        <button 
          onClick={() => setActiveTab('salary')}
          className={cn("px-6 py-2 rounded-xl font-bold text-sm transition-all", 
            activeTab === 'salary' ? "bg-gray-900 text-white shadow-lg shadow-gray-900/20" : "text-gray-500 hover:bg-gray-50"
          )}
        >
          Salary Calculation
        </button>
      </div>

      {activeTab === 'salary' ? (
        <SalaryCalculator users={users} allRequests={allRequests} />
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-6">
            <div className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Pending Leaves</p>
              <p className="text-4xl font-bold text-orange-600">{pending.length}</p>
            </div>
            <div className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Pending Encash</p>
              <p className="text-4xl font-bold text-blue-600">{pendingEncash.length}</p>
            </div>
            <div className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Total Processed</p>
              <p className="text-4xl font-bold text-gray-900">{history.length}</p>
            </div>
            <button 
              onClick={() => setShowPastLeaveModal(true)}
              className="bg-purple-600 p-6 rounded-3xl text-white shadow-xl shadow-purple-600/20 hover:bg-purple-700 transition-all text-left group"
            >
              <p className="text-xs font-bold text-purple-200 uppercase tracking-widest mb-1">Implementation Support</p>
              <p className="text-xl font-bold flex items-center gap-2 group-hover:translate-x-1 transition-transform">
                <Plus className="w-5 h-5" /> Add Past Record
              </p>
            </button>
          </div>

          {/* Change Requests */}
      {changeRequests.length > 0 && (
        <div className="bg-orange-50 rounded-3xl p-8 border border-orange-100 shadow-sm">
          <h3 className="text-2xl font-bold text-orange-900 mb-8 flex items-center gap-3">
            Absent Change Requests
            <span className="bg-orange-200 text-orange-700 text-xs px-2 py-1 rounded-full">{changeRequests.length}</span>
          </h3>
          <div className="space-y-4">
            {changeRequests.map(req => (
              <div key={req.id} className="bg-white p-6 rounded-2xl flex items-center justify-between shadow-sm border border-orange-100">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-bold text-gray-900">{req.employeeName}</p>
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">on {format(new Date(req.startDate), 'MMM dd')}</span>
                  </div>
                  <p className="text-sm text-gray-600">Requested: <span className="font-bold text-orange-600">{req.changeRequest?.requestedType}</span></p>
                  <p className="text-sm text-gray-500 italic mt-2">"{req.changeRequest?.reason}"</p>
                </div>
                <div className="flex gap-2 ml-4">
                  <button 
                    onClick={() => onChangeAbsent(req)} 
                    className="bg-orange-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-orange-700 transition-all flex items-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" /> Review & Change
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Encashment Requests */}
      {pendingEncash.length > 0 && (
        <div className="bg-blue-50 rounded-3xl p-8 border border-blue-100 shadow-sm">
          <h3 className="text-2xl font-bold text-blue-900 mb-8 flex items-center gap-3">
            PL/EL Encashment Requests
            <span className="bg-blue-200 text-blue-700 text-xs px-2 py-1 rounded-full">{pendingEncash.length}</span>
          </h3>
          <div className="space-y-4">
            {pendingEncash.map(req => (
              <div key={req.id} className="bg-white p-4 rounded-2xl flex items-center justify-between shadow-sm border border-blue-100">
                <div>
                  <p className="font-bold text-gray-900">{req.employeeName}</p>
                  <p className="text-sm text-gray-500">Requested encashment of {req.amount} days PL/EL</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleEncashAction(req.id, 'approved')} className="bg-green-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-green-700 transition-all">Approve</button>
                  <button onClick={() => handleEncashAction(req.id, 'rejected')} className="bg-red-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-red-700 transition-all">Reject</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending List */}
      <div className="bg-white rounded-3xl p-8 border border-gray-200 shadow-sm">
        <h3 className="text-2xl font-bold text-gray-900 mb-8 flex items-center gap-3">
          Pending Approvals
          {pending.length > 0 && <span className="bg-orange-100 text-orange-600 text-xs px-2 py-1 rounded-full">{pending.length}</span>}
        </h3>

        {pending.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            <CheckCircle className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p className="text-lg font-medium">All caught up!</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left border-b border-gray-100">
                  <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Employee</th>
                  <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Leave Type</th>
                  <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Duration</th>
                  <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Reason</th>
                  <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {pending.map(req => (
                  <tr key={req.id} className="group hover:bg-gray-50/50 transition-colors">
                    <td className="py-5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-bold text-xs">
                          {req.employeeName.charAt(0)}
                        </div>
                        <span className="font-bold text-gray-900">{req.employeeName}</span>
                      </div>
                    </td>
                    <td className="py-5">
                      <span className={cn("px-2 py-1 rounded-full text-[10px] font-bold uppercase", 
                        LEAVE_TYPES.find(t => t.value === req.leaveType)?.color
                      )}>
                        {req.leaveType}
                      </span>
                    </td>
                    <td className="py-5">
                      <p className="text-sm font-bold text-gray-800">{req.days} Days</p>
                      <p className="text-[10px] text-gray-400 uppercase font-bold">{format(new Date(req.startDate), 'MMM dd')} - {format(new Date(req.endDate), 'MMM dd')}</p>
                    </td>
                    <td className="py-5">
                      <p className="text-sm text-gray-500 max-w-xs truncate">{req.reason}</p>
                    </td>
                    <td className="py-5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {req.leaveType === 'Absent' && (
                          <button 
                            onClick={() => onChangeAbsent(req)}
                            className="p-2 text-orange-600 hover:bg-orange-50 rounded-xl transition-colors"
                            title="Revoke/Change Absent Status"
                          >
                            <RefreshCw className="w-6 h-6" />
                          </button>
                        )}
                        <button 
                          onClick={() => handleAction(req.id, 'approved')}
                          className="p-2 text-green-600 hover:bg-green-50 rounded-xl transition-colors"
                        >
                          <CheckCircle className="w-6 h-6" />
                        </button>
                        <button 
                          onClick={() => handleAction(req.id, 'rejected')}
                          className="p-2 text-red-600 hover:bg-red-50 rounded-xl transition-colors"
                        >
                          <XCircle className="w-6 h-6" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* History List */}
      <div className="bg-white rounded-3xl p-8 border border-gray-200 shadow-sm">
        <h3 className="text-xl font-bold text-gray-900 mb-6">Recent Activity</h3>
        <div className="space-y-4">
          {history.slice(0, 5).map(req => (
            <div key={req.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div className="flex items-center gap-4">
                <div className="text-xs font-bold text-gray-400 w-24">
                  {format(req.createdAt?.toDate() || new Date(), 'MMM dd, HH:mm')}
                </div>
                <div className="font-bold text-gray-900">{req.employeeName}</div>
                <div className="text-sm text-gray-500">{req.leaveType} for {req.days} days</div>
              </div>
              <div className="flex items-center gap-4">
                {req.leaveType === 'Absent' && (
                  <button 
                    onClick={() => onChangeAbsent(req)}
                    className="p-2 text-orange-600 hover:bg-orange-50 rounded-xl transition-colors"
                    title="Revoke/Change Absent Status"
                  >
                    <RefreshCw className="w-5 h-5" />
                  </button>
                )}
                <StatusBadge status={req.status} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {showPastLeaveModal && (
        <AddPastLeaveModal users={users} onClose={() => setShowPastLeaveModal(false)} />
      )}
        </>
      )}
    </div>
  );
}

function ChangeRequestModal({ request, onClose }: { request: LeaveRequest; onClose: () => void }) {
  const [requestedType, setRequestedType] = useState<LeaveType>('CL');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await updateDoc(doc(db, 'leaveRequests', request.id), {
        changeRequest: {
          requestedType,
          reason,
          status: 'pending'
        },
        updatedAt: serverTimestamp()
      });
      onClose();
    } catch (err) {
      console.error("Error submitting change request:", err);
      alert("Failed to submit request.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 z-50">
      <div className="bg-white rounded-[32px] w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="bg-orange-600 p-8 text-white">
          <h3 className="text-2xl font-bold">Request Change</h3>
          <p className="text-orange-100 text-sm mt-1">For date: {format(new Date(request.startDate), 'MMM dd, yyyy')}</p>
        </div>
        
        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Requested Leave Type</label>
              <select 
                value={requestedType}
                onChange={(e) => setRequestedType(e.target.value as LeaveType)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
              >
                {LEAVE_TYPES.filter(t => t.value !== 'Absent' && t.value !== 'WPL').map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Genuine Reason</label>
              <textarea 
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none min-h-[100px]"
                placeholder="Explain why you were absent and why it should be changed..."
                required
              />
            </div>
          </div>

          <button 
            type="submit"
            disabled={loading}
            className="w-full bg-orange-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-orange-700 transition-all shadow-xl shadow-orange-600/20"
          >
            {loading ? 'Submitting...' : 'Submit Change Request'}
          </button>
        </form>
      </div>
    </div>
  );
}

function ChangeAbsentModal({ request, onClose }: { request: LeaveRequest; onClose: () => void }) {
  const [newType, setNewType] = useState<LeaveType>(request.changeRequest?.requestedType || 'CL');
  const [hrComment, setHrComment] = useState(request.changeRequest?.reason ? `Approved change request: ${request.changeRequest.reason}` : '');
  const [loading, setLoading] = useState(false);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const userRef = doc(db, 'users', request.uid);
      const userSnap = await getDoc(userRef);
      if (!userSnap.exists()) throw new Error("User not found");
      const userData = userSnap.data() as UserProfile;
      const currentBalance = userData.balances[newType as keyof LeaveBalances] || 0;

      if (newType !== 'WPL' && currentBalance < request.days) {
        alert(`Insufficient ${newType} balance for this employee.`);
        setLoading(false);
        return;
      }

      // 1. Update request
      await updateDoc(doc(db, 'leaveRequests', request.id), {
        leaveType: newType,
        isIndiscipline: false,
        hrComment: hrComment || `Changed from Absent to ${newType} by HR`,
        status: 'approved',
        changeRequest: request.changeRequest ? {
          ...request.changeRequest,
          status: 'approved',
          hrComment: hrComment
        } : null,
        updatedAt: serverTimestamp()
      });

      // 2. Deduct from new balance if not WPL
      if (newType !== 'WPL') {
        await updateDoc(userRef, {
          [`balances.${newType}`]: Math.max(0, currentBalance - request.days)
        });
      }

      onClose();
    } catch (err) {
      console.error("Error updating absent status:", err);
      alert("Failed to update status.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 z-50">
      <div className="bg-white rounded-[32px] w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="bg-blue-600 p-8 text-white">
          <h3 className="text-2xl font-bold">Revoke Absent Status</h3>
          <p className="text-blue-100 text-sm mt-1">For {request.employeeName} on {format(new Date(request.startDate), 'MMM dd')}</p>
        </div>
        
        <form onSubmit={handleUpdate} className="p-8 space-y-6">
          <div className="space-y-4">
            {request.changeRequest && (
              <div className="p-4 bg-orange-50 rounded-2xl border border-orange-100">
                <p className="text-[10px] font-bold text-orange-600 uppercase tracking-widest mb-1">Employee Request</p>
                <p className="text-sm text-gray-700 font-bold">Requested: {request.changeRequest.requestedType}</p>
                <p className="text-xs text-gray-500 italic mt-1">"{request.changeRequest.reason}"</p>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">New Leave Type</label>
              <select 
                value={newType}
                onChange={(e) => setNewType(e.target.value as LeaveType)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
              >
                {LEAVE_TYPES.filter(t => t.value !== 'Absent').map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">HR Comment</label>
              <textarea 
                value={hrComment}
                onChange={(e) => setHrComment(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none min-h-[100px]"
                placeholder="Reason for revoking absent status..."
                required
              />
            </div>
          </div>

          <div className="flex gap-3">
            <button 
              type="button"
              onClick={onClose}
              className="flex-1 bg-gray-100 text-gray-700 py-4 px-6 rounded-2xl font-bold hover:bg-gray-200 transition-all"
            >
              Cancel
            </button>
            <button 
              type="submit"
              disabled={loading}
              className="flex-1 bg-blue-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-xl shadow-blue-600/20"
            >
              {loading ? 'Updating...' : 'Update Status'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ApplyLeaveModal({ profile, onClose }: { profile: UserProfile; onClose: () => void }) {
  const [leaveType, setLeaveType] = useState<LeaveType>('CL');
  const [startDate, setStartDate] = useState(format(addDays(new Date(), 3), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(addDays(new Date(), 3), 'yyyy-MM-dd'));
  const [isHalfDay, setIsHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const days = isHalfDay ? 0.5 : (differenceInDays(new Date(endDate), new Date(startDate)) + 1);
  const balance = profile.balances[leaveType as keyof LeaveBalances] || 0;
  
  const isAdvanceNotice = differenceInDays(new Date(startDate), startOfDay(new Date())) >= 3;
  const isCLValid = leaveType === 'CL' ? days <= 3 : true;
  const needsCertificate = leaveType === 'SL' && days > 2;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (days <= 0) return alert("End date must be after start date");
    if (leaveType !== 'WPL' && days > balance) return alert("Insufficient balance");
    if (leaveType === 'CL' && days > 3) return alert("Casual leave cannot exceed 3 days at a stretch");

    setSubmitting(true);
    try {
      await addDoc(collection(db, 'leaveRequests'), {
        uid: profile.uid,
        employeeName: profile.displayName,
        leaveType,
        startDate,
        endDate: isHalfDay ? startDate : endDate,
        days,
        isHalfDay,
        reason,
        status: 'pending',
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now()
      });
      onClose();
    } catch (e) {
      console.error("Error applying for leave:", e);
      alert("Failed to submit request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 z-50">
      <div className="bg-white rounded-[32px] w-full max-w-xl overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="bg-orange-600 p-8 text-white">
          <h3 className="text-2xl font-bold">Apply for Leave</h3>
          <p className="text-orange-100 text-sm mt-1">Please fill in the details below</p>
        </div>
        
        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Leave Type</label>
              <select 
                value={leaveType}
                onChange={(e) => setLeaveType(e.target.value as LeaveType)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
              >
                {LEAVE_TYPES.filter(t => t.value !== 'Absent').map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Available Balance</label>
              <div className="bg-gray-100 rounded-xl px-4 py-3 font-bold text-gray-900">
                {leaveType === 'WPL' ? 'N/A' : `${balance} Days`}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Start Date</label>
              <input 
                type="date" 
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (isHalfDay) setEndDate(e.target.value);
                }}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">End Date</label>
              <input 
                type="date" 
                value={isHalfDay ? startDate : endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={isHalfDay}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none disabled:opacity-50"
                required
              />
            </div>
          </div>

          <div className="flex items-center gap-3 bg-gray-50 p-4 rounded-2xl border border-gray-100">
            <input 
              type="checkbox" 
              id="halfDay"
              checked={isHalfDay}
              onChange={(e) => {
                setIsHalfDay(e.target.checked);
                if (e.target.checked) setEndDate(startDate);
              }}
              className="w-5 h-5 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
            />
            <label htmlFor="halfDay" className="text-sm font-bold text-gray-700 cursor-pointer">
              Apply for Half Day
            </label>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Reason</label>
            <textarea 
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-medium text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none h-24 resize-none"
              placeholder="Briefly explain the reason for leave..."
              required
            />
          </div>

          {/* Policy Warnings */}
          <div className="space-y-2">
            {!isAdvanceNotice && (
              <div className="flex items-center gap-2 text-orange-600 bg-orange-50 p-3 rounded-xl text-xs font-bold">
                <AlertCircle className="w-4 h-4" />
                Note: Policy requires 3 days advance notice for non-emergencies.
              </div>
            )}
            {!isCLValid && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-xl text-xs font-bold">
                <AlertCircle className="w-4 h-4" />
                Error: Casual Leave cannot exceed 3 days at a stretch.
              </div>
            )}
            {needsCertificate && (
              <div className="flex items-center gap-2 text-blue-600 bg-blue-50 p-3 rounded-xl text-xs font-bold">
                <AlertCircle className="w-4 h-4" />
                Note: Sick Leave {'>'} 2 days requires a doctor's certificate.
              </div>
            )}
          </div>

          <div className="flex items-center gap-4 pt-4">
            <button 
              type="button"
              onClick={onClose}
              className="flex-1 py-4 px-6 rounded-2xl font-bold text-gray-500 hover:bg-gray-100 transition-all"
            >
              Cancel
            </button>
            <button 
              type="submit"
              disabled={submitting || !isCLValid || days <= 0}
              className="flex-1 bg-gray-900 text-white py-4 px-6 rounded-2xl font-bold hover:bg-black transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-xl shadow-gray-900/20"
            >
              {submitting ? 'Submitting...' : `Request ${days} Days`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CompleteProfileModal({ profile, onComplete }: { profile: UserProfile; onComplete: (profile: UserProfile) => void }) {
  const [designation, setDesignation] = useState(profile.designation || '');
  const [dob, setDob] = useState(profile.dob || '');
  const [doj, setDoj] = useState(profile.doj || '');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const updatedProfile = {
        ...profile,
        designation,
        dob,
        doj
      };
      await updateDoc(doc(db, 'users', profile.uid), {
        designation,
        dob,
        doj
      });
      onComplete(updatedProfile);
    } catch (e) {
      console.error("Error updating profile:", e);
      alert("Failed to update profile. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 z-50">
      <div className="bg-white rounded-[32px] w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="bg-gray-900 p-8 text-white">
          <h3 className="text-2xl font-bold">Complete Your Profile</h3>
          <p className="text-gray-400 text-sm mt-1">Please provide your professional details</p>
        </div>
        
        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Designation</label>
            <input 
              type="text" 
              value={designation}
              onChange={(e) => setDesignation(e.target.value)}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
              placeholder="e.g. Software Engineer"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Date of Birth</label>
            <input 
              type="date" 
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Date of Joining</label>
            <input 
              type="date" 
              value={doj}
              onChange={(e) => setDoj(e.target.value)}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
              required
            />
          </div>

          <button 
            type="submit"
            disabled={submitting}
            className="w-full bg-orange-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-orange-700 transition-all disabled:opacity-50 shadow-xl shadow-orange-600/20"
          >
            {submitting ? 'Saving...' : 'Complete Profile'}
          </button>
        </form>
      </div>
    </div>
  );
}

function HRCalendar({ allRequests }: { allRequests: LeaveRequest[] }) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const approvedRequests = allRequests.filter(r => r.status === 'approved');

  const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
  const firstDayOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay();

  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const blanks = Array.from({ length: firstDayOfMonth }, (_, i) => i);

  const nextMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1));
  const prevMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1));

  const getLeavesForDay = (day: number) => {
    const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day);
    return approvedRequests.filter(req => {
      const start = new Date(req.startDate);
      const end = new Date(req.endDate);
      return date >= start && date <= end;
    });
  };

  return (
    <div className="bg-white rounded-[32px] p-8 border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between mb-8">
        <h3 className="text-2xl font-bold text-gray-900">Company Leave Calendar</h3>
        <div className="flex items-center gap-4">
          <button onClick={prevMonth} className="p-2 hover:bg-gray-100 rounded-full transition-all"><ChevronRight className="w-5 h-5 rotate-180" /></button>
          <span className="font-bold text-lg min-w-[150px] text-center">{format(currentMonth, 'MMMM yyyy')}</span>
          <button onClick={nextMonth} className="p-2 hover:bg-gray-100 rounded-full transition-all"><ChevronRight className="w-5 h-5" /></button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px bg-gray-200 border border-gray-200 rounded-2xl overflow-hidden">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="bg-gray-50 p-4 text-center text-xs font-bold text-gray-400 uppercase tracking-widest">{d}</div>
        ))}
        {blanks.map(b => <div key={`b-${b}`} className="bg-white p-4 h-32"></div>)}
        {days.map(d => {
          const dayLeaves = getLeavesForDay(d);
          return (
            <div key={d} className="bg-white p-2 h-32 border-t border-gray-100 overflow-y-auto">
              <span className="text-sm font-bold text-gray-400 mb-2 block">{d}</span>
              <div className="space-y-1">
                {dayLeaves.map(l => (
                  <div key={l.id} className={cn("text-[10px] p-1 rounded font-bold truncate", 
                    LEAVE_TYPES.find(t => t.value === l.leaveType)?.color
                  )}>
                    {l.employeeName}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EncashLeaveModal({ profile, onClose }: { profile: UserProfile; onClose: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const amount = profile.balances.PL;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (new Date().getMonth() !== 0) return alert("Encashment only available in January");
    
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'encashmentRequests'), {
        uid: profile.uid,
        employeeName: profile.displayName,
        amount,
        status: 'pending',
        createdAt: Timestamp.now()
      });
      onClose();
    } catch (e) {
      console.error("Error submitting encashment:", e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 z-50">
      <div className="bg-white rounded-[32px] w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="bg-blue-600 p-8 text-white">
          <h3 className="text-2xl font-bold">PL/EL Encashment</h3>
          <p className="text-blue-100 text-sm mt-1">Request to cash out your earned leave</p>
        </div>
        
        <div className="p-8 space-y-6">
          <div className="bg-blue-50 p-6 rounded-2xl text-center">
            <p className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-2">Available for Encashment</p>
            <p className="text-5xl font-bold text-blue-700">{amount} <span className="text-xl">Days</span></p>
          </div>

          <p className="text-sm text-gray-500 italic text-center">
            Note: As per policy, encashing will reset your PL/EL balance to zero upon approval.
          </p>

          <div className="flex items-center gap-4 pt-4">
            <button onClick={onClose} className="flex-1 py-4 px-6 rounded-2xl font-bold text-gray-500 hover:bg-gray-100 transition-all">Cancel</button>
            <button 
              onClick={handleSubmit}
              disabled={submitting || amount <= 0}
              className="flex-1 bg-blue-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-blue-700 transition-all disabled:opacity-50 shadow-xl shadow-blue-600/20"
            >
              {submitting ? 'Submitting...' : 'Request Cashout'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SalaryCalculator({ users, allRequests }: { users: UserProfile[]; allRequests: LeaveRequest[] }) {
  const [selectedMonth, setSelectedMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [results, setResults] = useState<{ userId: string; name: string; salary: number; absentDays: number; payable: number }[]>([]);

  const calculate = () => {
    const [year, month] = selectedMonth.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    
    const res = users.filter(u => u.role === 'employee').map(user => {
      const monthlySalary = user.salary || 0;
      const dailySalary = monthlySalary / daysInMonth;
      
      // Filter approved leaves for this month that are WPL or Absent
      const monthRequests = allRequests.filter(req => {
        if (req.uid !== user.uid || req.status !== 'approved') return false;
        if (req.leaveType !== 'WPL' && req.leaveType !== 'Absent') return false;
        
        const start = new Date(req.startDate);
        return start.getFullYear() === year && (start.getMonth() + 1) === month;
      });
      
      const absentDays = monthRequests.reduce((sum, req) => sum + req.days, 0);
      const payable = Math.max(0, monthlySalary - (absentDays * dailySalary));
      
      return {
        userId: user.uid,
        name: user.displayName,
        salary: monthlySalary,
        absentDays,
        payable
      };
    });
    
    setResults(res);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-[32px] p-8 border border-gray-200 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <h3 className="text-2xl font-bold text-gray-900">Salary Calculation</h3>
            <p className="text-gray-500 text-sm">Calculate monthly payable salary based on attendance</p>
          </div>
          <div className="flex items-center gap-3">
            <input 
              type="month" 
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <button 
              onClick={calculate}
              className="bg-gray-900 text-white px-6 py-3 rounded-xl font-bold hover:bg-black transition-all shadow-lg shadow-gray-900/20 flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Calculate
            </button>
          </div>
        </div>

        {results.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Employee</th>
                  <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Base Salary</th>
                  <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-center">Absent/WPL Days</th>
                  <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right">Payable Salary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {results.map(res => (
                  <tr key={res.userId} className="hover:bg-gray-50/50 transition-colors">
                    <td className="py-4 font-bold text-gray-900">{res.name}</td>
                    <td className="py-4 font-medium text-gray-600">₹{res.salary.toLocaleString()}</td>
                    <td className="py-4 text-center">
                      <span className={cn("px-2 py-1 rounded-lg text-xs font-bold", 
                        res.absentDays > 0 ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                      )}>
                        {res.absentDays} Days
                      </span>
                    </td>
                    <td className="py-4 text-right">
                      <p className="text-lg font-bold text-gray-900">₹{Math.round(res.payable).toLocaleString()}</p>
                      <p className="text-[10px] text-gray-400 font-bold uppercase tracking-tighter">Net Payable</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-12 bg-gray-50 rounded-2xl border border-dashed border-gray-200">
            <p className="text-gray-400 font-medium">Select a month and click calculate to see results</p>
          </div>
        )}
      </div>
    </div>
  );
}

function AddPastLeaveModal({ users, onClose }: { users: UserProfile[]; onClose: () => void }) {
  const [selectedUid, setSelectedUid] = useState('');
  const [leaveType, setLeaveType] = useState<LeaveType>('CL');
  const [startDate, setStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [reason, setReason] = useState('Previous record entry');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUid) return alert("Please select an employee");
    setLoading(true);
    try {
      const user = users.find(u => u.uid === selectedUid);
      if (!user) throw new Error("User not found");

      const days = differenceInDays(new Date(endDate), new Date(startDate)) + 1;

      await addDoc(collection(db, 'leaveRequests'), {
        uid: selectedUid,
        employeeName: user.displayName,
        leaveType,
        startDate,
        endDate,
        days,
        reason,
        status: 'approved', // Past records are usually already approved
        hrComment: 'Entered as past record by HR',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      // Deduct from balance if not WPL/Absent
      if (leaveType !== 'WPL' && leaveType !== 'Absent') {
        const currentBalance = user.balances[leaveType as keyof LeaveBalances] || 0;
        await updateDoc(doc(db, 'users', selectedUid), {
          [`balances.${leaveType}`]: Math.max(0, currentBalance - days)
        });
      }

      onClose();
    } catch (err) {
      console.error("Error adding past leave:", err);
      alert("Failed to add record.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 z-50">
      <div className="bg-white rounded-[32px] w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="bg-purple-600 p-8 text-white">
          <h3 className="text-2xl font-bold">Add Past Leave Record</h3>
          <p className="text-purple-100 text-sm mt-1">Enter leave data from before system implementation</p>
        </div>
        
        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Select Employee</label>
              <select 
                value={selectedUid}
                onChange={(e) => setSelectedUid(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-purple-500 outline-none"
                required
              >
                <option value="">Choose employee...</option>
                {users.filter(u => u.role === 'employee').map(u => (
                  <option key={u.uid} value={u.uid}>{u.displayName}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Leave Type</label>
                <select 
                  value={leaveType}
                  onChange={(e) => setLeaveType(e.target.value as LeaveType)}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-purple-500 outline-none"
                >
                  {LEAVE_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Reason</label>
                <input 
                  type="text" 
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-purple-500 outline-none"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Start Date</label>
                <input 
                  type="date" 
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-purple-500 outline-none"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">End Date</label>
                <input 
                  type="date" 
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-purple-500 outline-none"
                  required
                />
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button 
              type="button"
              onClick={onClose}
              className="flex-1 bg-gray-100 text-gray-700 py-4 px-6 rounded-2xl font-bold hover:bg-gray-200 transition-all"
            >
              Cancel
            </button>
            <button 
              type="submit"
              disabled={loading}
              className="flex-1 bg-purple-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-purple-700 transition-all shadow-xl shadow-purple-600/20"
            >
              {loading ? 'Adding...' : 'Add Record'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function UserManagement({ 
  setSelectedUserForCompOff, 
  setShowAddCompOffModal,
  setSelectedUserForAbsent,
  setShowMarkAbsentModal
}: { 
  setSelectedUserForCompOff: (u: UserProfile) => void; 
  setShowAddCompOffModal: (b: boolean) => void;
  setSelectedUserForAbsent: (u: UserProfile) => void;
  setShowMarkAbsentModal: (b: boolean) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [salary, setSalary] = useState('');
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  useEffect(() => {
    const q = query(collection(db, 'users'), orderBy('displayName', 'asc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setUsers(snapshot.docs.map(doc => doc.data() as UserProfile));
    });
    return () => unsubscribe();
  }, []);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      // 1. Create Auth User using secondary app (to stay logged in as HR)
      const userCredential = await registerUser(email, password);
      const newUser = userCredential.user;

      // 2. Create Firestore Profile
      const userRef = doc(db, 'users', newUser.uid);
      const now = new Date();
      const currentMonthKey = `${now.getMonth()}-${now.getFullYear()}`;
      
      await setDoc(userRef, {
        uid: newUser.uid,
        email: email,
        displayName: displayName,
        photoURL: `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=random`,
        role: 'employee',
        salary: Number(salary) || 0,
        balances: { ...INITIAL_BALANCES },
        lastAccrualUpdate: currentMonthKey
      });

      setMessage({ type: 'success', text: `User ${displayName} created successfully!` });
      setEmail('');
      setPassword('');
      setDisplayName('');
      setSalary('');
    } catch (err: any) {
      console.error("Error creating user:", err);
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async (uid: string, name: string) => {
    if (!window.confirm(`Are you sure you want to delete the profile for ${name}? This will remove their leave data from the system.`)) return;
    
    try {
      await deleteDoc(doc(db, 'users', uid));
      // Note: Full Auth deletion requires Admin SDK, but removing Firestore profile effectively disables app access
    } catch (e) {
      console.error("Error deleting user:", e);
      alert("Failed to delete user profile.");
    }
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setLoading(true);
    try {
      await updateDoc(doc(db, 'users', editingUser.uid), {
        displayName: editingUser.displayName,
        designation: editingUser.designation,
        salary: Number(editingUser.salary) || 0,
        role: editingUser.role
      });
      setEditingUser(null);
    } catch (e) {
      console.error("Error updating user:", e);
      alert("Failed to update user.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Create User Form */}
      <div className="bg-white rounded-[32px] p-8 border border-gray-200 shadow-sm">
        <div className="flex items-center gap-3 mb-8">
          <div className="bg-blue-100 p-3 rounded-2xl text-blue-600">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-2xl font-bold text-gray-900">Create New User</h3>
            <p className="text-gray-500 text-sm">Add a new employee to the system</p>
          </div>
        </div>

        <form onSubmit={handleCreateUser} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Full Name</label>
              <input 
                type="text" 
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="John Doe"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Email Address</label>
              <input 
                type="email" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="john@rosium.com"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Initial Password</label>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="••••••••"
                required
                minLength={6}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Monthly Salary</label>
              <input 
                type="number" 
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="50000"
                required
              />
            </div>
          </div>

          {message && (
            <div className={cn("p-4 rounded-xl text-sm font-bold flex items-center gap-3", 
              message.type === 'success' ? "bg-green-50 text-green-600" : "bg-red-50 text-red-600"
            )}>
              {message.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
              {message.text}
            </div>
          )}

          <button 
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-xl shadow-blue-600/20 flex items-center justify-center gap-2"
          >
            {loading ? 'Creating User...' : (
              <>
                <Plus className="w-5 h-5" />
                Create Employee Account
              </>
            )}
          </button>
        </form>
      </div>

      {/* User List */}
      <div className="bg-white rounded-[32px] p-8 border border-gray-200 shadow-sm">
        <h3 className="text-2xl font-bold text-gray-900 mb-6">Employee Directory</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Employee</th>
                <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Designation</th>
                <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Salary</th>
                <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Role</th>
                <th className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {users.map(u => (
                <tr key={u.uid} className="group hover:bg-gray-50/50 transition-colors">
                  <td className="py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center font-bold text-gray-500">
                        {u.displayName.charAt(0)}
                      </div>
                      <div>
                        <p className="font-bold text-gray-900">{u.displayName}</p>
                        <p className="text-xs text-gray-500">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-4 font-medium text-gray-600">{u.designation || 'Not set'}</td>
                  <td className="py-4 font-bold text-gray-900">₹{u.salary?.toLocaleString() || '0'}</td>
                  <td className="py-4">
                    <span className={cn("px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider", 
                      u.role === 'hr' ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"
                    )}>
                      {u.role}
                    </span>
                  </td>
                  <td className="py-4 text-right">
                    <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button 
                        onClick={() => {
                          setSelectedUserForCompOff(u);
                          setShowAddCompOffModal(true);
                        }}
                        className="p-2 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all"
                        title="Add CompOff"
                      >
                        <Clock className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => {
                          setSelectedUserForAbsent(u);
                          setShowMarkAbsentModal(true);
                        }}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                        title="Mark Absent"
                      >
                        <XCircle className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => setEditingUser(u)}
                        className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => handleDeleteUser(u.uid, u.displayName)}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 z-50">
          <div className="bg-white rounded-[32px] w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="bg-gray-900 p-8 text-white">
              <h3 className="text-2xl font-bold">Edit User Profile</h3>
              <p className="text-gray-400 text-sm mt-1">{editingUser.email}</p>
            </div>
            
            <form onSubmit={handleUpdateUser} className="p-8 space-y-6">
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Full Name</label>
                <input 
                  type="text" 
                  value={editingUser.displayName}
                  onChange={(e) => setEditingUser({...editingUser, displayName: e.target.value})}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Designation</label>
                <input 
                  type="text" 
                  value={editingUser.designation || ''}
                  onChange={(e) => setEditingUser({...editingUser, designation: e.target.value})}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g. Senior Developer"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Monthly Salary</label>
                <input 
                  type="number" 
                  value={editingUser.salary || ''}
                  onChange={(e) => setEditingUser({...editingUser, salary: Number(e.target.value)})}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="50000"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Role</label>
                <select 
                  value={editingUser.role}
                  onChange={(e) => setEditingUser({...editingUser, role: e.target.value as any})}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="employee">Employee</option>
                  <option value="hr">HR</option>
                </select>
              </div>

              <div className="flex items-center gap-4 pt-4">
                <button 
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="flex-1 py-4 px-6 rounded-2xl font-bold text-gray-500 hover:bg-gray-100 transition-all"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  disabled={loading}
                  className="flex-1 bg-blue-600 text-white py-4 px-6 rounded-2xl font-bold hover:bg-blue-700 transition-all disabled:opacity-50 shadow-xl shadow-blue-600/20"
                >
                  {loading ? 'Saving...' : 'Update Profile'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: LeaveRequest['status'] }) {
  const styles = {
    pending: 'bg-orange-100 text-orange-600',
    approved: 'bg-green-100 text-green-600',
    rejected: 'bg-red-100 text-red-600',
  };

  return (
    <span className={cn("px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5", styles[status])}>
      {status === 'pending' && <Clock className="w-3 h-3" />}
      {status === 'approved' && <CheckCircle className="w-3 h-3" />}
      {status === 'rejected' && <XCircle className="w-3 h-3" />}
      {status}
    </span>
  );
}
