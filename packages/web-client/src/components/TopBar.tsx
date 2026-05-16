import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Calendar, Users, CheckSquare, StickyNote, Search, Bell, Settings, LogOut, ChevronDown } from 'lucide-react';
import { useAuthStore } from '../store/auth.js';

interface Props {
  onSearch: (q: string) => void;
  currentApp: 'mail' | 'calendar' | 'contacts' | 'tasks' | 'notes';
}

export function TopBar({ onSearch, currentApp }: Props) {
  const navigate = useNavigate();
  const { displayName, email, logout } = useAuthStore();
  const [search, setSearch] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);

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
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm text-white/90 hover:bg-white/20 transition-colors ${
              currentApp === id ? 'bg-white/20 font-medium' : ''
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </nav>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex-1 max-w-xl mx-4">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/60" />
          <input
            type="text"
            placeholder="Suchen..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-white/20 text-white placeholder-white/60 border border-white/30 rounded px-3 py-1 pl-8 text-sm outline-none focus:bg-white/30 transition-colors"
          />
        </div>
      </form>

      {/* Right actions */}
      <div className="ml-auto flex items-center gap-1">
        <button className="p-1.5 rounded text-white/80 hover:bg-white/20 transition-colors">
          <Bell size={17} />
        </button>
        <button onClick={() => navigate('/settings')} className="p-1.5 rounded text-white/80 hover:bg-white/20 transition-colors">
          <Settings size={17} />
        </button>

        {/* Profile */}
        <div className="relative">
          <button
            onClick={() => setProfileOpen((o) => !o)}
            className="flex items-center gap-1.5 ml-1 px-2 py-1 rounded text-white/90 hover:bg-white/20 transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-white/30 flex items-center justify-center text-xs font-bold text-white">
              {displayName?.charAt(0).toUpperCase() ?? '?'}
            </div>
            <ChevronDown size={13} />
          </button>

          {profileOpen && (
            <div className="absolute right-0 top-full mt-1 w-52 bg-white shadow-lg border border-gray-200 rounded py-1 z-50">
              <div className="px-3 py-2 border-b border-gray-100">
                <p className="font-medium text-sm text-gray-800">{displayName}</p>
                <p className="text-xs text-gray-500">{email}</p>
              </div>
              <button
                onClick={() => { logout(); navigate('/login'); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                <LogOut size={14} />
                Abmelden
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
