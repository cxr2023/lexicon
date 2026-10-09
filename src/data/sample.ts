import { createEntry } from '../lib/domain';
import type { Entry } from '../types';

export function sampleEntries(): Entry[] {
  const rows: [string, string, string, string, string][] = [
    ['serendipity', '/ˌserənˈdɪpəti/', 'The chance discovery of something pleasant or valuable when you are not looking for it.', '意外发现美好事物的机缘；意外之喜', 'Finding this little bookshop was pure {{serendipity}}.'],
    ['take your time', '/teɪk jʊr taɪm/', 'To do something at a comfortable speed, without needing to hurry.', '慢慢来，不着急', 'There is no rush. {{Take your time}}.'],
    ['resilient', '/rɪˈzɪliənt/', 'Able to recover and become strong again after something difficult happens.', '有韧性的；能迅速恢复的', 'Small, consistent habits help us become more {{resilient}}.'],
    ['break the ice', '/breɪk ði aɪs/', 'To make people feel more relaxed when they first meet.', '打破僵局，活跃气氛', 'She told a joke to {{break the ice}}.'],
    ['a little goes a long way', '/ə ˈlɪtəl ɡoʊz ə lɔŋ weɪ/', 'A small amount of something can have a surprisingly useful or large effect.', '一点点也能发挥很大的作用', 'With kindness, {{a little goes a long way}}.'],
    ['thoughtful', '/ˈθɔtfəl/', 'Showing care for other people, or thinking carefully about something.', '体贴的；经过认真思考的', 'It was a {{thoughtful}} gift.'],
    ['perspective', '/pərˈspektɪv/', 'A particular way of thinking about or looking at a situation.', '看待事物的角度；观点', 'Reading gives us a different {{perspective}}.'],
    ['look forward to', '/lʊk ˈfɔrwərd tu/', 'To feel happy and excited about something that will happen.', '期待，盼望', 'I {{look forward to}} seeing you again.'],
    ['curiosity', '/ˌkjʊriˈɑsəti/', 'A strong desire to learn about or understand something.', '好奇心；求知欲', 'Let your {{curiosity}} lead the way.'],
    ['make sense', '/meɪk sens/', 'To be clear, reasonable, or easy to understand.', '有道理；说得通', 'The explanation helped everything {{make sense}}.'],
    ['Every little bit helps.', '/ˈevri ˈlɪtəl bɪt helps/', 'Even a small contribution can make a useful difference.', '点滴付出都有帮助。', '{{Every little bit helps}} when you are learning something new.'],
    ['mindful', '/ˈmaɪndfəl/', 'Paying careful attention to something or being aware of it.', '留意的；用心的', 'Be {{mindful}} of the small things.'],
  ];
  return rows.map(([term, ipa_us, definition_en, meaning_zh, example], i) => createEntry({
    term, ipa_us, definition_en, meaning_zh, example,
    type: term.endsWith('.') ? 'sentence' : term === 'break the ice' ? 'idiom' : term.includes(' ') ? 'phrase' : 'word',
    tags: i % 2 ? ['日常表达'] : ['生活与成长'], favorite: i < 3,
    source: '词间 · 示例词库', created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  }));
}
