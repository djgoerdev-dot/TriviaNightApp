import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, X, Trash2, Check, ChevronRight, ChevronDown, Upload,
  Coffee, Calendar, MapPin, FileSpreadsheet, AlertTriangle, Download
} from 'lucide-react';

export const MAX_CATEGORIES = 9;
export const MAX_QUESTIONS_PER_CATEGORY = 8;

interface EventSummary {
  id: string;
  title: string;
  event_date: string | null;
  location: string | null;
  categoryCount: number;
  questionCount: number;
}

interface QuestionRow {
  id: string;
  prompt: string;
  correct_answer: string;
  points: number;
  time_limit_seconds: number;
  position: number;
}

interface CategoryRow {
  id: string;
  title: string;
  position: number;
  break_after: number;
  break_note: string | null;
  questions: QuestionRow[];
}

interface EventDetail {
  id: string;
  title: string;
  event_date: string | null;
  location: string | null;
  categories: CategoryRow[];
}

interface ImportReport {
  filename: string;
  mode: string;
  rowsRead: number;
  categoriesCreated: number;
  questionsImported: number;
  skipped: { rowNumber: number; reason: string }[];
}

interface Props {
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onLaunch: (eventId: string) => void;
}

/** An input that keeps a local draft and saves when it loses focus. */
const AutoField: React.FC<{
  value: string;
  onSave: (next: string) => unknown | Promise<unknown>;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  type?: string;
  maxLength?: number;
  ariaLabel: string;
}> = ({ value, onSave, placeholder, className = '', multiline, type = 'text', maxLength, ariaLabel }) => {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);
  const isFocusedRef = useRef(false);

  useEffect(() => {
    if (!isFocusedRef.current) {
      setDraft(value);
    }
  }, [value]);

  const commit = async () => {
    isFocusedRef.current = false;
    const next = draft.trim();
    if (next === (value ?? '').trim()) return;
    if (!next && type !== 'date') {
      setDraft(value); // refuse to blank a required field
      return;
    }
    await onSave(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const shared = {
    value: draft,
    placeholder,
    maxLength,
    'aria-label': ariaLabel,
    onFocus: () => { isFocusedRef.current = true; },
    onBlur: commit,
    className:
      `w-full bg-transparent border border-transparent hover:border-[#D2DACF] focus:border-[#1B7A5A] ` +
      `focus:bg-white rounded-lg px-2 py-1.5 outline-none transition-colors ${className} ` +
      (saved ? 'ring-1 ring-[#1B7A5A]/40' : '')
  };

  if (multiline) {
    return (
      <textarea
        {...shared}
        rows={2}
        onChange={e => setDraft(e.target.value)}
      />
    );
  }

  return (
    <input
      {...shared}
      type={type}
      onChange={e => setDraft(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
};

export const AuthoringStudio: React.FC<Props> = ({ authFetch, onLaunch }) => {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showNewEvent, setShowNewEvent] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newLocation, setNewLocation] = useState('');

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [importMode, setImportMode] = useState<'append' | 'replace'>('append');
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const loadEvents = useCallback(async () => {
    try {
      const res = await authFetch('/api/events');
      const data = await res.json();
      setEvents(data.events || []);
      return data.events || [];
    } catch (err: any) {
      setError(err.message || 'Could not load events');
      return [];
    }
  }, [authFetch]);

  const loadDetail = useCallback(async (eventId: string) => {
    if (!eventId) { setDetail(null); return; }
    try {
      const res = await authFetch(`/api/events/${eventId}`);
      if (!res.ok) { setDetail(null); return; }
      const data = await res.json();
      setDetail(data.event);
    } catch (err: any) {
      setError(err.message || 'Could not load that event');
    }
  }, [authFetch]);

  useEffect(() => { loadEvents(); }, [loadEvents]);
  useEffect(() => { loadDetail(selectedId); }, [selectedId, loadDetail]);

  /** Runs a mutation, then refreshes the event and the summary counts. */
  const mutate = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || 'That change could not be saved');
        return false;
      }
      await loadDetail(selectedId);
      await loadEvents();
      return true;
    } catch (err: any) {
      setError(err.message || 'That change could not be saved');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          title: newTitle.trim(),
          eventDate: newDate.trim(),
          location: newLocation.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not create the event'); return; }

      setNewTitle(''); setNewDate(''); setNewLocation('');
      setShowNewEvent(false);
      await loadEvents();
      setSelectedId(data.id);
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (file: File) => {
    if (!selectedId) return;
    setImporting(true);
    setError(null);
    setImportReport(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await authFetch(`/api/events/${selectedId}/import?mode=${importMode}`, {
        method: 'POST',
        body: form
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'That file could not be imported');
        if (data.problems?.length) {
          setImportReport({
            filename: file.name, mode: importMode, rowsRead: 0,
            categoriesCreated: 0, questionsImported: 0, skipped: data.problems
          });
        }
        return;
      }
      setImportReport(data);
      await loadDetail(selectedId);
      await loadEvents();
    } catch (err: any) {
      setError(err.message || 'That file could not be imported');
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const downloadTemplate = () => {
    const csv = [
      'category,question,answer,points',
      'Philippine History,Who was the first president of the Philippine Republic?,Emilio Aguinaldo,2',
      'Philippine History,In which year did Magellan arrive in the Philippines?,1521,1',
      'World Geography,What is the capital city of Australia?,Canberra,1'
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'trivia-questions-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalPoints = (cat: CategoryRow) => cat.questions.reduce((sum, q) => sum + q.points, 0);
  const eventPoints = detail?.categories.reduce((sum, c) => sum + totalPoints(c), 0) ?? 0;
  const eventQuestions = detail?.categories.reduce((sum, c) => sum + c.questions.length, 0) ?? 0;

  return (
    <div className="flex-1 p-6 max-w-5xl mx-auto w-full flex flex-col gap-5">
      {error && (
        <div className="p-3 rounded-xl bg-[#F6DEDB] text-[#B93E33] text-sm font-semibold flex items-start justify-between gap-3">
          <span className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            {error}
          </span>
          <button onClick={() => setError(null)} className="underline opacity-70 hover:opacity-100 text-xs">
            Dismiss
          </button>
        </div>
      )}

      {/* ---------- 1. Events ---------- */}
      <section className="bg-white border border-[#D2DACF] rounded-2xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold">Events</h2>
            <p className="text-xs text-[#5C6B64]">Pick one to edit, or create a new night.</p>
          </div>
          <button
            onClick={() => setShowNewEvent(v => !v)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1B7A5A] hover:bg-[#146046] text-white text-xs font-bold shadow"
          >
            <Plus size={14} /> New Event
          </button>
        </div>

        {showNewEvent && (
          <form onSubmit={createEvent} className="mb-4 p-4 rounded-xl border border-[#D2DACF] bg-[#EFF2EE] grid gap-3 md:grid-cols-3">
            <div className="md:col-span-3">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#5C6B64] mb-1" htmlFor="new-event-title">
                Event name
              </label>
              <input
                id="new-event-title"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder="NWTF Trivia Night — September"
                maxLength={120}
                className="w-full px-3 py-2 rounded-lg border border-[#D2DACF] bg-white text-sm font-semibold"
                required
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#5C6B64] mb-1" htmlFor="new-event-date">
                Date
              </label>
              <input
                id="new-event-date"
                type="date"
                value={newDate}
                onChange={e => setNewDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[#D2DACF] bg-white text-sm"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#5C6B64] mb-1" htmlFor="new-event-location">
                Location
              </label>
              <input
                id="new-event-location"
                value={newLocation}
                onChange={e => setNewLocation(e.target.value)}
                placeholder="Bacolod branch canteen"
                maxLength={160}
                className="w-full px-3 py-2 rounded-lg border border-[#D2DACF] bg-white text-sm"
              />
            </div>
            <div className="md:col-span-3 flex items-center justify-between">
              <p className="text-[11px] text-[#5C6B64]">Date and location are for your records — they don't affect the game.</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowNewEvent(false)} className="px-3 py-2 text-xs font-bold text-[#5C6B64]">
                  Cancel
                </button>
                <button type="submit" disabled={busy || !newTitle.trim()} className="px-4 py-2 rounded-lg bg-[#1B7A5A] text-white text-xs font-bold disabled:opacity-40">
                  Create Event
                </button>
              </div>
            </div>
          </form>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {events.length === 0 && (
            <p className="text-sm text-[#5C6B64] py-4">No events yet. Create one to get started.</p>
          )}
          {events.map(ev => {
            const active = ev.id === selectedId;
            return (
              <button
                key={ev.id}
                onClick={() => setSelectedId(active ? '' : ev.id)}
                className={`text-left p-4 rounded-xl border transition-all ${
                  active ? 'border-[#1B7A5A] bg-[#D9EDE5]/40 ring-1 ring-[#1B7A5A]/30' : 'border-[#D2DACF] hover:border-[#5C6B64]'
                }`}
              >
                <h3 className="font-bold text-sm">{ev.title}</h3>
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px] text-[#5C6B64]">
                  {ev.event_date && <span className="flex items-center gap-1"><Calendar size={11} />{ev.event_date}</span>}
                  {ev.location && <span className="flex items-center gap-1"><MapPin size={11} />{ev.location}</span>}
                </div>
                <p className="mt-2 text-[11px] font-mono text-[#5C6B64]">
                  {ev.categoryCount} categories · {ev.questionCount} questions
                </p>
              </button>
            );
          })}
        </div>
      </section>

      {detail && (
        <>
          {/* ---------- Event details ---------- */}
          <section className="bg-white border border-[#D2DACF] rounded-2xl p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4 mb-3">
              <h2 className="text-lg font-bold">Event details</h2>
              <button
                onClick={() => onLaunch(detail.id)}
                disabled={eventQuestions === 0}
                className="px-4 py-2 rounded-xl bg-[#1B7A5A] hover:bg-[#146046] text-white text-xs font-bold shadow disabled:opacity-40"
                title={eventQuestions === 0 ? 'Add some questions first' : 'Start a live session'}
              >
                Launch Live Night
              </button>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="md:col-span-3">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[#5C6B64] mb-1">Event name</label>
                <AutoField
                  ariaLabel="Event name"
                  value={detail.title}
                  maxLength={120}
                  className="text-base font-bold"
                  onSave={v => mutate(() => authFetch(`/api/events/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ title: v }) }))}
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[#5C6B64] mb-1">Date</label>
                <AutoField
                  ariaLabel="Event date"
                  type="date"
                  value={detail.event_date || ''}
                  className="text-sm"
                  onSave={v => mutate(() => authFetch(`/api/events/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ eventDate: v }) }))}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[#5C6B64] mb-1">Location</label>
                <AutoField
                  ariaLabel="Event location"
                  value={detail.location || ''}
                  maxLength={160}
                  placeholder="Venue"
                  className="text-sm"
                  onSave={v => mutate(() => authFetch(`/api/events/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ location: v }) }))}
                />
              </div>
            </div>

            <p className="mt-3 text-[11px] font-mono text-[#5C6B64]">
              {detail.categories.length}/{MAX_CATEGORIES} categories · {eventQuestions} questions · {eventPoints} points total
            </p>
          </section>

          {/* ---------- Import ---------- */}
          <section className="bg-white border border-[#D2DACF] rounded-2xl p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <FileSpreadsheet size={17} className="text-[#1B7A5A]" />
              <h2 className="text-lg font-bold">Import questions</h2>
            </div>
            <p className="text-xs text-[#5C6B64] mb-4">
              An .xlsx or .csv file with columns <b>category</b>, <b>question</b>, <b>answer</b> and <b>points</b>.
              Column order doesn't matter; points defaults to 1 if the column is missing.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <label className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold cursor-pointer shadow ${
                importing ? 'bg-[#E3E9E1] text-[#5C6B64]' : 'bg-[#1B7A5A] hover:bg-[#146046] text-white'
              }`}>
                <Upload size={14} />
                {importing ? 'Importing…' : 'Choose file'}
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,.csv"
                  disabled={importing}
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) handleUpload(f);
                  }}
                />
              </label>

              <div className="flex items-center gap-1 bg-[#E3E9E1] p-1 rounded-lg text-xs font-bold">
                {(['append', 'replace'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => setImportMode(m)}
                    className={`px-3 py-1.5 rounded-md capitalize ${importMode === m ? 'bg-white shadow-sm' : 'text-[#5C6B64]'}`}
                  >
                    {m}
                  </button>
                ))}
              </div>

              <button onClick={downloadTemplate} className="flex items-center gap-1.5 text-xs font-bold text-[#5C6B64] hover:text-[#14181A] underline">
                <Download size={13} /> Download template
              </button>
            </div>

            <p className="mt-2 text-[11px] text-[#5C6B64]">
              {importMode === 'append'
                ? 'Adds to whatever is already here.'
                : 'Clears every existing question in this event first. Categories and their breaks are kept.'}
            </p>

            {importReport && (
              <div className="mt-4 p-3 rounded-xl border border-[#D2DACF] bg-[#EFF2EE]">
                <p className="text-xs font-bold text-[#14181A]">
                  {importReport.questionsImported > 0
                    ? `Imported ${importReport.questionsImported} questions` +
                      (importReport.categoriesCreated ? ` and created ${importReport.categoriesCreated} categories` : '') +
                      ` from ${importReport.filename}.`
                    : `Nothing was imported from ${importReport.filename}.`}
                </p>
                {importReport.skipped.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-[#B93E33] mb-1">
                      {importReport.skipped.length} row{importReport.skipped.length === 1 ? '' : 's'} skipped
                    </p>
                    <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                      {importReport.skipped.map((s, i) => (
                        <li key={i} className="text-[11px] text-[#5C6B64] font-mono">
                          {s.rowNumber > 0 ? `Row ${s.rowNumber}: ` : ''}{s.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ---------- Categories, breaks and questions ---------- */}
          <section className="bg-white border border-[#D2DACF] rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-bold">Running order</h2>
              <button
                onClick={() => mutate(() => authFetch(`/api/events/${detail.id}/categories`, {
                  method: 'POST',
                  body: JSON.stringify({ title: `Category ${detail.categories.length + 1}` })
                }))}
                disabled={busy || detail.categories.length >= MAX_CATEGORIES}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#D2DACF] hover:border-[#1B7A5A] text-xs font-bold disabled:opacity-40"
              >
                <Plus size={14} /> Add Category
              </button>
            </div>
            <p className="text-xs text-[#5C6B64] mb-4">
              Top to bottom is exactly what happens on the night.
            </p>

            {detail.categories.length === 0 && (
              <p className="text-sm text-[#5C6B64] py-6 text-center">
                No categories yet. Add one, or import a spreadsheet to create them automatically.
              </p>
            )}

            <div className="space-y-3">
              {detail.categories.map((cat, idx) => {
                const isCollapsed = collapsed[cat.id];
                const isLast = idx === detail.categories.length - 1;
                return (
                  <React.Fragment key={cat.id}>
                    <div className="rounded-xl border border-[#D2DACF] overflow-hidden">
                      {/* Category header */}
                      <div className="flex items-center gap-2 p-3 bg-[#EFF2EE]">
                        <button
                          onClick={() => setCollapsed(c => ({ ...c, [cat.id]: !c[cat.id] }))}
                          className="p-1 text-[#5C6B64] hover:text-[#14181A]"
                          aria-label={isCollapsed ? 'Expand category' : 'Collapse category'}
                        >
                          {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                        </button>
                        <span className="font-mono text-xs font-bold text-[#5C6B64] w-5">{idx + 1}</span>
                        <AutoField
                          ariaLabel={`Category ${idx + 1} name`}
                          value={cat.title}
                          maxLength={60}
                          className="font-bold text-sm flex-1"
                          onSave={v => mutate(() => authFetch(`/api/categories/${cat.id}`, { method: 'PATCH', body: JSON.stringify({ title: v }) }))}
                        />
                        {cat.questions.length === 0 ? (
                          <span className="text-[10px] font-bold text-[#B93E33] bg-[#F6DEDB] px-2 py-0.5 rounded-full uppercase tracking-wider whitespace-nowrap">
                            0 questions
                          </span>
                        ) : (
                          <span className="font-mono text-[11px] text-[#5C6B64] whitespace-nowrap">
                            {cat.questions.length}/{MAX_QUESTIONS_PER_CATEGORY} q · {totalPoints(cat)} pts
                          </span>
                        )}
                        <button
                          onClick={() => {
                            if (confirm(`Delete "${cat.title}" and its ${cat.questions.length} questions?`)) {
                              mutate(() => authFetch(`/api/categories/${cat.id}`, { method: 'DELETE' }));
                            }
                          }}
                          className="p-1.5 rounded-lg text-[#5C6B64] hover:text-[#B93E33] hover:bg-[#F6DEDB]"
                          aria-label={`Delete category ${cat.title}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      {!isCollapsed && (
                        <div className="p-3">
                          {/* Question table */}
                          <div className="hidden md:grid grid-cols-[1.5rem_1fr_14rem_4.5rem_2rem] gap-2 px-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#5C6B64]">
                            <span />
                            <span>Question</span>
                            <span>Answer</span>
                            <span>Points</span>
                            <span />
                          </div>

                          <div className="space-y-1">
                            {cat.questions.map((q, qIdx) => (
                              <div
                                key={q.id}
                                className="grid grid-cols-1 md:grid-cols-[1.5rem_1fr_14rem_4.5rem_2rem] gap-2 items-start p-1 rounded-lg hover:bg-[#EFF2EE]"
                              >
                                <span className="font-mono text-[11px] text-[#5C6B64] pt-2">{qIdx + 1}</span>
                                <AutoField
                                  ariaLabel={`Question ${qIdx + 1} prompt`}
                                  value={q.prompt}
                                  multiline
                                  maxLength={500}
                                  className="text-sm resize-y"
                                  onSave={v => mutate(() => authFetch(`/api/questions/${q.id}`, { method: 'PATCH', body: JSON.stringify({ prompt: v }) }))}
                                />
                                <AutoField
                                  ariaLabel={`Question ${qIdx + 1} answer`}
                                  value={q.correct_answer}
                                  maxLength={300}
                                  className="text-sm font-semibold text-[#1B7A5A]"
                                  onSave={v => mutate(() => authFetch(`/api/questions/${q.id}`, { method: 'PATCH', body: JSON.stringify({ correctAnswer: v }) }))}
                                />
                                <AutoField
                                  ariaLabel={`Question ${qIdx + 1} points`}
                                  type="number"
                                  value={String(q.points)}
                                  className="text-sm font-mono font-bold text-center"
                                  onSave={v => mutate(() => authFetch(`/api/questions/${q.id}`, { method: 'PATCH', body: JSON.stringify({ points: Number(v) || 1 }) }))}
                                />
                                <button
                                  onClick={() => mutate(() => authFetch(`/api/questions/${q.id}`, { method: 'DELETE' }))}
                                  className="p-1.5 rounded-lg text-[#5C6B64] hover:text-[#B93E33] hover:bg-[#F6DEDB] justify-self-start"
                                  aria-label={`Delete question ${qIdx + 1}`}
                                >
                                  <X size={14} />
                                </button>
                              </div>
                            ))}
                          </div>

                          <button
                            onClick={() => mutate(() => authFetch(`/api/categories/${cat.id}/questions`, {
                              method: 'POST',
                              body: JSON.stringify({ prompt: 'New question', correctAnswer: 'Answer', points: 1 })
                            }))}
                            disabled={busy || cat.questions.length >= MAX_QUESTIONS_PER_CATEGORY}
                            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-[#1B7A5A] hover:bg-[#D9EDE5] disabled:opacity-40"
                          >
                            <Plus size={13} /> Add question
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Break control — sits between this category and the next */}
                    {!isLast && (
                      <div className={`flex flex-wrap items-center gap-3 px-3 py-2 rounded-xl border border-dashed ${
                        cat.break_after ? 'border-[#1B7A5A] bg-[#D9EDE5]/40' : 'border-[#D2DACF]'
                      }`}>
                        <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cat.break_after === 1}
                            onChange={e => mutate(() => authFetch(`/api/categories/${cat.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ breakAfter: e.target.checked })
                            }))}
                            className="accent-[#1B7A5A] w-4 h-4"
                          />
                          <Coffee size={14} className={cat.break_after ? 'text-[#1B7A5A]' : 'text-[#5C6B64]'} />
                          Break after {cat.title}
                        </label>

                        {cat.break_after === 1 && (
                          <div className="flex-1 min-w-[12rem]">
                            <AutoField
                              ariaLabel={`Break note after ${cat.title}`}
                              value={cat.break_note || ''}
                              placeholder="Optional note — e.g. Dinner, 15 minutes"
                              maxLength={80}
                              className="text-xs"
                              onSave={v => mutate(() => authFetch(`/api/categories/${cat.id}`, { method: 'PATCH', body: JSON.stringify({ breakNote: v }) }))}
                            />
                          </div>
                        )}

                        {cat.break_after === 1 && (
                          <span className="text-[11px] text-[#1B7A5A] font-semibold flex items-center gap-1">
                            <Check size={12} /> You control when it ends
                          </span>
                        )}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
};
