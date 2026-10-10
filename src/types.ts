export type EntryType = 'word' | 'phrase' | 'idiom' | 'sentence';
export type CardKind = 'recognition' | 'production' | 'cloze';
export type RatingValue = 1 | 2 | 3 | 4;

export interface VerbForms {
  base: string; third_person: string; past: string; past_participle: string; present_participle: string; note?: string;
}
export interface ComparisonForms {
  positive: string; comparative: string; superlative: string; note?: string;
}
export interface Derivative { term: string; pos: string; meaning: string; affix: string }
export interface WordForms { verb?: VerbForms; comparison?: ComparisonForms; derivatives?: Derivative[] }

export interface Entry {
  id: string; term: string; ipa_us: string; definition_en: string; meaning_zh: string;
  type: EntryType; pos: string; example: string; example_translation: string;
  usage: string; tags: string[]; source: string; notes: string;
  favorite: boolean; suspended: boolean; created_at: string; updated_at: string; revision: number;
  word_forms?: WordForms;
}
export interface FSRSState {
  due: string; stability: number; difficulty: number; elapsed_days: number;
  scheduled_days: number; learning_steps: number; reps: number; lapses: number;
  state: number; last_review?: string;
}
export interface StudyCard {
  id: string; entry_id: string; kind: CardKind; state: FSRSState;
  revision: number; bury_until: string | null;
}
export interface ReviewEvent {
  id: string; card_id: string; entry_id: string; rating: RatingValue; reviewed_at: string;
  before: StudyCard; after: StudyCard; undone: boolean;
}
export interface StudyBatch {
  id: string; entry_ids: string[]; completed_ids: string[]; created_at: string; completed_at: string | null;
}
export interface Settings {
  batch_size: number; timezone: string; hide_chinese: boolean;
  production_enabled: boolean; cloze_enabled: boolean; retention: number;
}
export interface Snapshot { entries: Entry[]; cards: StudyCard[]; reviews: ReviewEvent[]; batches: StudyBatch[]; settings: Settings }
export interface Backup { version: 1; exported_at: string; data: Snapshot }
export interface ReviewInput {
  operation_id: string; card_id: string; expected_revision: number;
  reviewed_at: string; rating: RatingValue; next_state: FSRSState;
}
export interface Repository {
  mode: 'cloud' | 'demo';
  load(): Promise<Snapshot>;
  saveEntries(entries: Entry[]): Promise<void>;
  startBatch(): Promise<StudyBatch | null>;
  submitReview(input: ReviewInput): Promise<void>;
  undoReview(reviewId: string): Promise<void>;
  deleteEntry(id: string, expectedRevision: number): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;
  restoreBackup(backup: Backup): Promise<void>;
}
export interface WorkspaceProps {
  snapshot: Snapshot; repository: Repository;
  refresh: () => Promise<void>;
  notify: (message: string, type?: 'success' | 'error') => void;
}
