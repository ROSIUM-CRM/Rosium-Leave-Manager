import React, { useState, useEffect } from 'react';
import { 
  onAuthStateChanged, 
  User as FirebaseUser 
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
  Timestamp,
  orderBy,
  getDocFromServer
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
  ChevronRight
} from 'lucide-react';
import { format, differenceInDays, addDays, isBefore, startOfDay } from 'date-fns';
import { auth, db, signInWithGoogle, logout } from './firebase';
import { cn } from './lib/utils';

// --- Types ---

type LeaveType = 'CL' | 'PL' | 'SL' | 'ML' | 'PaL' | 'CompOff' | 'LWP';

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
}

const LEAVE_TYPES: { label: string; value: LeaveType; color: string }[] = [
  { label: 'Casual Leave (CL)', value: 'CL', color: 'bg-blue-100 text-blue-700' },
  { label: 'Privilege Leave (PL)', value: 'PL', color: 'bg-green-100 text-green-700' },
  { label: 'Sick Leave (SL)', value: 'SL', color: 'bg-red-100 text-red-700' },
  { label: 'Maternity Leave (ML)', value: 'ML', color: 'bg-purple-100 text-purple-700' },
  { label: 'Paternity Leave (PaL)', value: 'PaL', color: 'bg-indigo-100 text-indigo-700' },
  { label: 'Compensatory Off', value: 'CompOff', color: 'bg-orange-100 text-orange-700' },
  { label: 'Leave Without Pay', value: 'LWP', color: 'bg-gray-100 text-gray-700' },
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

function calculateAccruedPL(doj: string, currentPL: number): number {
  if (!doj) return currentPL;
  const joinDate = new Date(doj);
  const now = new Date();
  
  // Calculate months since joining
  const monthsDiff = (now.getFullYear() - joinDate.getFullYear()) * 12 + (now.getMonth() - joinDate.getMonth());
  
  if (monthsDiff <= 0) return currentPL;

  // Accrual: 1.5 days per month
  // We should ideally track the last accrual date to avoid over-calculating
  // For this demo, we'll assume the balance stored is the current one and we just show the logic
  // A real system would run a cron job or update on login
  return Math.min(45, currentPL); // Max 45 days cumulative
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
  const [viewMode, setViewMode] = useState<'dashboard' | 'calendar'>('dashboard');

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
          setProfile(data);
          // Check if profile is incomplete
          if (!data.designation || !data.dob || !data.doj) {
            setShowProfileModal(true);
          }
        } else {
          // Create new profile
          const isHR = firebaseUser.email === 'hr.rosium@gmail.com';
          const newProfile: UserProfile = {
            uid: firebaseUser.uid,
            email: firebaseUser.email || '',
            displayName: firebaseUser.displayName || 'Employee',
            photoURL: firebaseUser.photoURL || '',
            role: isHR ? 'hr' : 'employee',
            balances: INITIAL_BALANCES,
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
            </div>
          )}
          <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-100 rounded-full">
            <img src={user.photoURL || ''} className="w-8 h-8 rounded-full border border-white" alt="User" />
            <div className="hidden sm:block">
              <p className="text-sm font-bold text-gray-800 leading-none">{profile?.displayName}</p>
              <p className="text-[10px] text-gray-500 uppercase font-bold mt-1">{profile?.role}</p>
            </div>
          </div>
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
          />
        ) : (
          viewMode === 'dashboard' ? (
            <HRDashboard 
              profile={profile} 
              allRequests={allRequests} 
              encashmentRequests={encashmentRequests}
            />
          ) : (
            <div className="lg:col-span-12">
              <HRCalendar allRequests={allRequests} />
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
    </div>
  );
}

// --- Sub-Components ---

function LoginScreen() {
  return (
    <div className="min-h-screen bg-[#F5F2ED] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-[32px] shadow-2xl shadow-orange-900/10 p-10 text-center border border-gray-100">
        <div className="bg-orange-600 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-lg shadow-orange-600/20">
          <Calendar className="text-white w-8 h-8" />
        </div>
        <h2 className="text-4xl font-serif font-bold text-gray-900 mb-2">Welcome Back</h2>
        <p className="text-gray-500 mb-10 text-lg">Rosium Developers Leave Management System</p>
        
        <button 
          onClick={signInWithGoogle}
          className="w-full flex items-center justify-center gap-3 bg-gray-900 text-white py-4 px-6 rounded-2xl font-bold hover:bg-black transition-all transform hover:-translate-y-1 active:scale-95 shadow-xl shadow-gray-900/20"
        >
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-6 h-6" alt="Google" />
          Sign in with Google
        </button>
        
        <div className="mt-10 pt-8 border-t border-gray-100">
          <p className="text-xs text-gray-400 uppercase tracking-widest font-bold">Authorized Access Only</p>
        </div>
      </div>
    </div>
  );
}

function EmployeeDashboard({ profile, requests, onApply, onEncash }: { profile: UserProfile; requests: LeaveRequest[]; onApply: () => void; onEncash: () => void }) {
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
                      <div className={cn("px-3 py-1 rounded-full text-[10px] font-bold uppercase h-fit", 
                        LEAVE_TYPES.find(t => t.value === req.leaveType)?.color
                      )}>
                        {req.leaveType}
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

function HRDashboard({ profile, allRequests, encashmentRequests }: { profile: UserProfile; allRequests: LeaveRequest[]; encashmentRequests: EncashmentRequest[] }) {
  const pending = allRequests.filter(r => r.status === 'pending');
  const history = allRequests.filter(r => r.status !== 'pending');
  const pendingEncash = encashmentRequests.filter(r => r.status === 'pending');

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

      // If approved, deduct from balance
      if (status === 'approved' && req.leaveType !== 'LWP') {
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
        <div className="bg-gray-900 p-6 rounded-3xl text-white shadow-xl shadow-gray-900/20">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">HR Status</p>
          <p className="text-xl font-bold flex items-center gap-2">
            <ShieldCheck className="text-orange-400" /> Active
          </p>
        </div>
      </div>

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
              <StatusBadge status={req.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ApplyLeaveModal({ profile, onClose }: { profile: UserProfile; onClose: () => void }) {
  const [leaveType, setLeaveType] = useState<LeaveType>('CL');
  const [startDate, setStartDate] = useState(format(addDays(new Date(), 3), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(addDays(new Date(), 3), 'yyyy-MM-dd'));
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const days = differenceInDays(new Date(endDate), new Date(startDate)) + 1;
  const balance = profile.balances[leaveType as keyof LeaveBalances] || 0;
  
  const isAdvanceNotice = differenceInDays(new Date(startDate), startOfDay(new Date())) >= 3;
  const isCLValid = leaveType === 'CL' ? days <= 3 : true;
  const needsCertificate = leaveType === 'SL' && days > 2;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (days <= 0) return alert("End date must be after start date");
    if (leaveType !== 'LWP' && days > balance) return alert("Insufficient balance");
    if (leaveType === 'CL' && days > 3) return alert("Casual leave cannot exceed 3 days at a stretch");

    setSubmitting(true);
    try {
      await addDoc(collection(db, 'leaveRequests'), {
        uid: profile.uid,
        employeeName: profile.displayName,
        leaveType,
        startDate,
        endDate,
        days,
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
                {LEAVE_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Available Balance</label>
              <div className="bg-gray-100 rounded-xl px-4 py-3 font-bold text-gray-900">
                {leaveType === 'LWP' ? 'N/A' : `${balance} Days`}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Start Date</label>
              <input 
                type="date" 
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">End Date</label>
              <input 
                type="date" 
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-bold text-gray-900 focus:ring-2 focus:ring-orange-500 outline-none"
                required
              />
            </div>
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
