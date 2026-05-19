import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Calendar, Users, CheckSquare, StickyNote, Search, Bell, Settings, LogOut, ChevronDown, Inbox } from 'lucide-react';
import { useAuthStore } from '../store/auth.js';
import { Avatar } from './Avatar.js';
import { OpenSharedMailboxModal } from './OpenSharedMailboxModal.js';

interface Props {
  onSearch: (q: string) => void;
  currentApp: 'mail' | 'calendar' | 'contacts' | 'tasks' | 'notes';
}

export function TopBar({ onSearch, currentApp }: Props) {
  const navigate = useNavigate();
  const { displayName, email, logout } = useAuthStore();
  const [search, setSearch] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [sharedOpen, setSharedOpen]   = useState(false);

  const apps = [
    { id: 'mail', label: 'Mail', icon: Mail, path: '/mail' },
    { id: 'calendar', label: 'Kalender', icon: Calendar, path: '/calendar' },
    { id: 'contacts', label: 'Kontakte', icon: Users, path: '/contacts' },
    { id: 'tasks', label: 'Aufgaben', icon: CheckSquare, path: '/tasks' },
    { id: 'notes', label: 'Notizen', icon: StickyNote, path: '/notes' },
  ] as const;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(search);
  };

  return (
    <header className="h-12 bg-accent flex items-center px-3 gap-3 shrink-0 z-50">
      {/* App launcher / brand */}
      <div className="flex items-center gap-2 text-white font-semibold text-base mr-2">
        <Mail size={18} />
        <span>CoreMail</span>
      </div>

      {/* App switcher */}
      <nav className="flex items-center gap-0.5">
        {apps.map(({ id, label, icon: Icon, path }) => (
          <button
            key={id}
            onClick={() => navigate(path)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm text-white/90 transition-all duration-150 active:scale-95 ${
              currentApp === id ? 'bg-white/20 font-medium shadow-sm' : 'hover:bg-white/15 hover:translate-y-[-1px]'
            }`}
          >
            <Icon size={15} className={currentApp === id ? '' : 'transition-transform duration-150 hover:scale-110'} />
            {label}
          </button>
        ))}
      </nav>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex-1 max-w-xl mx-4">
        <div className="relative group">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/60 group-focus-within:text-white transition-colors" />
          <input
            type="text"
            placeholder="Suchen..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-white/20 text-white placeholder-white/60 border border-white/30 rounded px-3 py-1 pl-8 text-sm outline-none transition-all duration-150 focus:bg-white focus:text-gray-900 focus:placeholder-gray-400 focus:shadow-md focus:border-white"
          />
        </div>
      </form>

      {/* Right actions */}
      <div className="ml-auto flex items-center gap-1">
        <button className="group/bell p-1.5 rounded text-white/80 hover:bg-white/20 transition-all duration-150 active:scale-90" title="Benachrichtigungen">
          <Bell size={17} className="transition-transform duration-150 group-hover/bell:rotate-12" />
        </button>
        <button onClick={() => navigate('/settings')} className="group/gear p-1.5 rounded text-white/80 hover:bg-white/20 transition-all duration-150 active:scale-90" title="Einstellungen">
          <Settings size={17} className="transition-transform duration-150 group-hover/gear:rotate-45" />
        </button>

        {/* Profile */}
        <div className="relative">
          <button
            onClick={() => setProfileOpen((o) => !o)}
            className="flex items-center gap-1.5 ml-1 px-2 py-1 rounded text-white/90 hover:bg-white/20 transition-all duration-150"
          >
            <div className="ring-2 ring-transparent hover:ring-white/40 rounded-full transition-all duration-150">
              <Avatar seed={email || displayName || 'user'} initials={(displayName?.charAt(0) || email?.charAt(0) || '?').toUpperCase()} size="sm" />
            </div>
            <ChevronDown size={13} className="transition-transform duration-150" style={{ transform: profileOpen ? 'rotate(180deg)' : 'rotate(0)' }} />
          </button>

          {profileOpen && (
            <div className="absolute right-0 top-full mt-1 w-60 bg-white dark:bg-gray-800 shadow-lg border border-gray-200 dark:border-gray-700 rounded py-1 z-50 animate-fly-in origin-top-right">
              <div className="px-3 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2.5">
                <Avatar seed={email || displayName || 'user'} initials={(displayName?.charAt(0) || email?.charAt(0) || '?').toUpperCase()} size="md" />
                <div className="min-w-0">
                  <p className="font-medium text-sm text-gray-800 dark:text-gray-100 truncate">{displayName}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{email}</p>
                </div>
              </div>
              <button
                onClick={() => { setProfileOpen(false); setSharedOpen(true); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <Inbox size={14} />
                Weiteres Postfach öffnen
              </button>
              <div className="border-t border-gray-100 dark:border-gray-700 my-1" />
              <button
                onClick={() => { logout(); navigate('/login'); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <LogOut size={14} />
                Abmelden
              </button>
            </div>
          )}
        </div>
      </div>
      {sharedOpen && <OpenSharedMailboxModal onClose={() => setSharedOpen(false)} />}
    </header>
  );
}
