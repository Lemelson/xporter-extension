// XPorter — Export Column Labels (i18n)
// Human-readable, localized labels for the CSV/XLSX header row. Used by csv.js
// in the service worker (importScripts). The underlying DATA keys never change
// (item['favorite_count'] etc.) and JSON keys always stay English — only the
// CSV/XLSX header row text is localized, and only when the user opts in.
//
// Resolution: COLUMN_LABELS[lang][key] → COLUMN_LABELS.en[key] → raw key.

const COLUMN_LABELS = {
    en: {
        id: 'ID', text: 'Text', tweet_url: 'Post URL', language: 'Language', type: 'Type',
        author_name: 'Author name', author_username: 'Author username', view_count: 'Views',
        bookmark_count: 'Bookmarks', favorite_count: 'Likes', retweet_count: 'Reposts',
        reply_count: 'Replies', quote_count: 'Quotes', created_at: 'Date', source: 'Source',
        hashtags: 'Hashtags', urls: 'Links', media_type: 'Media type', media_urls: 'Media URLs',
        name: 'Name', username: 'Username', bio: 'Bio', location: 'Location', url: 'URL',
        followers_count: 'Followers', following_count: 'Following', tweet_count: 'Posts',
        listed_count: 'Lists', verified: 'Verified', protected: 'Protected',
        profile_image_url: 'Profile image URL', profile_url: 'Profile URL'
    },
    ru: {
        id: 'ID', text: 'Текст', tweet_url: 'Ссылка на пост', language: 'Язык', type: 'Тип',
        author_name: 'Имя автора', author_username: 'Логин автора', view_count: 'Просмотры',
        bookmark_count: 'Закладки', favorite_count: 'Лайки', retweet_count: 'Репосты',
        reply_count: 'Ответы', quote_count: 'Цитаты', created_at: 'Дата', source: 'Источник',
        hashtags: 'Хэштеги', urls: 'Ссылки', media_type: 'Тип медиа', media_urls: 'Ссылки на медиа',
        name: 'Имя', username: 'Логин', bio: 'Описание', location: 'Местоположение', url: 'Ссылка',
        followers_count: 'Подписчики', following_count: 'Подписки', tweet_count: 'Посты',
        listed_count: 'Списки', verified: 'Верифицирован', protected: 'Закрытый',
        profile_image_url: 'Ссылка на аватар', profile_url: 'Ссылка на профиль'
    },
    zh: {
        id: 'ID', text: '文本', tweet_url: '帖子链接', language: '语言', type: '类型',
        author_name: '作者名称', author_username: '作者用户名', view_count: '浏览量',
        bookmark_count: '收藏数', favorite_count: '点赞数', retweet_count: '转发数',
        reply_count: '回复数', quote_count: '引用数', created_at: '日期', source: '来源',
        hashtags: '话题标签', urls: '链接', media_type: '媒体类型', media_urls: '媒体链接',
        name: '名称', username: '用户名', bio: '简介', location: '位置', url: '网址',
        followers_count: '粉丝数', following_count: '关注数', tweet_count: '帖子数',
        listed_count: '列表数', verified: '已认证', protected: '受保护',
        profile_image_url: '头像链接', profile_url: '主页链接'
    },
    ja: {
        id: 'ID', text: '本文', tweet_url: '投稿URL', language: '言語', type: '種類',
        author_name: '投稿者名', author_username: '投稿者ユーザー名', view_count: '表示回数',
        bookmark_count: 'ブックマーク数', favorite_count: 'いいね数', retweet_count: 'リポスト数',
        reply_count: '返信数', quote_count: '引用数', created_at: '日付', source: 'ソース',
        hashtags: 'ハッシュタグ', urls: 'リンク', media_type: 'メディア種類', media_urls: 'メディアURL',
        name: '名前', username: 'ユーザー名', bio: '自己紹介', location: '場所', url: 'URL',
        followers_count: 'フォロワー数', following_count: 'フォロー数', tweet_count: '投稿数',
        listed_count: 'リスト数', verified: '認証済み', protected: '非公開',
        profile_image_url: 'プロフィール画像URL', profile_url: 'プロフィールURL'
    },
    es: {
        id: 'ID', text: 'Texto', tweet_url: 'URL de la publicación', language: 'Idioma', type: 'Tipo',
        author_name: 'Nombre del autor', author_username: 'Usuario del autor', view_count: 'Visualizaciones',
        bookmark_count: 'Guardados', favorite_count: 'Me gusta', retweet_count: 'Reposts',
        reply_count: 'Respuestas', quote_count: 'Citas', created_at: 'Fecha', source: 'Fuente',
        hashtags: 'Hashtags', urls: 'Enlaces', media_type: 'Tipo de medio', media_urls: 'URLs de medios',
        name: 'Nombre', username: 'Usuario', bio: 'Biografía', location: 'Ubicación', url: 'URL',
        followers_count: 'Seguidores', following_count: 'Siguiendo', tweet_count: 'Publicaciones',
        listed_count: 'Listas', verified: 'Verificado', protected: 'Protegido',
        profile_image_url: 'URL de la foto de perfil', profile_url: 'URL del perfil'
    },
    ko: {
        id: 'ID', text: '텍스트', tweet_url: '게시물 URL', language: '언어', type: '유형',
        author_name: '작성자 이름', author_username: '작성자 사용자명', view_count: '조회수',
        bookmark_count: '북마크수', favorite_count: '좋아요수', retweet_count: '리포스트수',
        reply_count: '답글수', quote_count: '인용수', created_at: '날짜', source: '출처',
        hashtags: '해시태그', urls: '링크', media_type: '미디어 유형', media_urls: '미디어 URL',
        name: '이름', username: '사용자명', bio: '소개', location: '위치', url: 'URL',
        followers_count: '팔로워수', following_count: '팔로잉수', tweet_count: '게시물수',
        listed_count: '리스트수', verified: '인증됨', protected: '비공개',
        profile_image_url: '프로필 이미지 URL', profile_url: '프로필 URL'
    },
    it: {
        id: 'ID', text: 'Testo', tweet_url: 'URL del post', language: 'Lingua', type: 'Tipo',
        author_name: 'Nome autore', author_username: 'Username autore', view_count: 'Visualizzazioni',
        bookmark_count: 'Segnalibri', favorite_count: 'Mi piace', retweet_count: 'Repost',
        reply_count: 'Risposte', quote_count: 'Citazioni', created_at: 'Data', source: 'Fonte',
        hashtags: 'Hashtag', urls: 'Link', media_type: 'Tipo di media', media_urls: 'URL media',
        name: 'Nome', username: 'Username', bio: 'Bio', location: 'Posizione', url: 'URL',
        followers_count: 'Follower', following_count: 'Seguiti', tweet_count: 'Post',
        listed_count: 'Liste', verified: 'Verificato', protected: 'Protetto',
        profile_image_url: 'URL immagine profilo', profile_url: 'URL profilo'
    },
    pt: {
        id: 'ID', text: 'Texto', tweet_url: 'URL da publicação', language: 'Idioma', type: 'Tipo',
        author_name: 'Nome do autor', author_username: 'Usuário do autor', view_count: 'Visualizações',
        bookmark_count: 'Salvos', favorite_count: 'Curtidas', retweet_count: 'Reposts',
        reply_count: 'Respostas', quote_count: 'Citações', created_at: 'Data', source: 'Origem',
        hashtags: 'Hashtags', urls: 'Links', media_type: 'Tipo de mídia', media_urls: 'URLs de mídia',
        name: 'Nome', username: 'Usuário', bio: 'Bio', location: 'Localização', url: 'URL',
        followers_count: 'Seguidores', following_count: 'Seguindo', tweet_count: 'Publicações',
        listed_count: 'Listas', verified: 'Verificado', protected: 'Protegido',
        profile_image_url: 'URL da foto de perfil', profile_url: 'URL do perfil'
    },
    tr: {
        id: 'ID', text: 'Metin', tweet_url: 'Gönderi URL\'si', language: 'Dil', type: 'Tür',
        author_name: 'Yazar adı', author_username: 'Yazar kullanıcı adı', view_count: 'Görüntülenme',
        bookmark_count: 'Yer imleri', favorite_count: 'Beğeni', retweet_count: 'Repost',
        reply_count: 'Yanıt', quote_count: 'Alıntı', created_at: 'Tarih', source: 'Kaynak',
        hashtags: 'Hashtagler', urls: 'Bağlantılar', media_type: 'Medya türü', media_urls: 'Medya URL\'leri',
        name: 'Ad', username: 'Kullanıcı adı', bio: 'Biyografi', location: 'Konum', url: 'URL',
        followers_count: 'Takipçi', following_count: 'Takip edilen', tweet_count: 'Gönderi',
        listed_count: 'Liste', verified: 'Doğrulanmış', protected: 'Gizli',
        profile_image_url: 'Profil resmi URL\'si', profile_url: 'Profil URL\'si'
    },
    de: {
        id: 'ID', text: 'Text', tweet_url: 'Beitrags-URL', language: 'Sprache', type: 'Typ',
        author_name: 'Autorname', author_username: 'Autor-Benutzername', view_count: 'Aufrufe',
        bookmark_count: 'Lesezeichen', favorite_count: 'Gefällt mir', retweet_count: 'Reposts',
        reply_count: 'Antworten', quote_count: 'Zitate', created_at: 'Datum', source: 'Quelle',
        hashtags: 'Hashtags', urls: 'Links', media_type: 'Medientyp', media_urls: 'Medien-URLs',
        name: 'Name', username: 'Benutzername', bio: 'Bio', location: 'Standort', url: 'URL',
        followers_count: 'Follower', following_count: 'Folgt', tweet_count: 'Beiträge',
        listed_count: 'Listen', verified: 'Verifiziert', protected: 'Geschützt',
        profile_image_url: 'Profilbild-URL', profile_url: 'Profil-URL'
    },
    ar: {
        id: 'المعرف', text: 'النص', tweet_url: 'رابط المنشور', language: 'اللغة', type: 'النوع',
        author_name: 'اسم الكاتب', author_username: 'معرف الكاتب', view_count: 'المشاهدات',
        bookmark_count: 'الإشارات المرجعية', favorite_count: 'الإعجابات', retweet_count: 'إعادات النشر',
        reply_count: 'الردود', quote_count: 'الاقتباسات', created_at: 'التاريخ', source: 'المصدر',
        hashtags: 'الوسوم', urls: 'الروابط', media_type: 'نوع الوسائط', media_urls: 'روابط الوسائط',
        name: 'الاسم', username: 'اسم المستخدم', bio: 'النبذة', location: 'الموقع', url: 'الرابط',
        followers_count: 'المتابِعون', following_count: 'المتابَعون', tweet_count: 'المنشورات',
        listed_count: 'القوائم', verified: 'موثّق', protected: 'محمي',
        profile_image_url: 'رابط صورة الملف الشخصي', profile_url: 'رابط الملف الشخصي'
    },
    fr: {
        id: 'ID', text: 'Texte', tweet_url: 'URL du post', language: 'Langue', type: 'Type',
        author_name: 'Nom de l\'auteur', author_username: 'Identifiant de l\'auteur', view_count: 'Vues',
        bookmark_count: 'Signets', favorite_count: 'J\'aime', retweet_count: 'Reposts',
        reply_count: 'Réponses', quote_count: 'Citations', created_at: 'Date', source: 'Source',
        hashtags: 'Hashtags', urls: 'Liens', media_type: 'Type de média', media_urls: 'URLs des médias',
        name: 'Nom', username: 'Identifiant', bio: 'Bio', location: 'Localisation', url: 'URL',
        followers_count: 'Abonnés', following_count: 'Abonnements', tweet_count: 'Posts',
        listed_count: 'Listes', verified: 'Vérifié', protected: 'Protégé',
        profile_image_url: 'URL de la photo de profil', profile_url: 'URL du profil'
    },
    hi: {
        id: 'ID', text: 'टेक्स्ट', tweet_url: 'पोस्ट URL', language: 'भाषा', type: 'प्रकार',
        author_name: 'लेखक का नाम', author_username: 'लेखक का यूज़रनेम', view_count: 'व्यूज़',
        bookmark_count: 'बुकमार्क', favorite_count: 'लाइक', retweet_count: 'रीपोस्ट',
        reply_count: 'रिप्लाई', quote_count: 'कोट', created_at: 'तारीख़', source: 'स्रोत',
        hashtags: 'हैशटैग', urls: 'लिंक', media_type: 'मीडिया प्रकार', media_urls: 'मीडिया URL',
        name: 'नाम', username: 'यूज़रनेम', bio: 'बायो', location: 'स्थान', url: 'URL',
        followers_count: 'फ़ॉलोअर्स', following_count: 'फ़ॉलोइंग', tweet_count: 'पोस्ट',
        listed_count: 'लिस्ट', verified: 'सत्यापित', protected: 'संरक्षित',
        profile_image_url: 'प्रोफ़ाइल इमेज URL', profile_url: 'प्रोफ़ाइल URL'
    },
    id: {
        id: 'ID', text: 'Teks', tweet_url: 'URL postingan', language: 'Bahasa', type: 'Tipe',
        author_name: 'Nama penulis', author_username: 'Username penulis', view_count: 'Tayangan',
        bookmark_count: 'Markah', favorite_count: 'Suka', retweet_count: 'Repost',
        reply_count: 'Balasan', quote_count: 'Kutipan', created_at: 'Tanggal', source: 'Sumber',
        hashtags: 'Tagar', urls: 'Tautan', media_type: 'Tipe media', media_urls: 'URL media',
        name: 'Nama', username: 'Username', bio: 'Bio', location: 'Lokasi', url: 'URL',
        followers_count: 'Pengikut', following_count: 'Mengikuti', tweet_count: 'Postingan',
        listed_count: 'Daftar', verified: 'Terverifikasi', protected: 'Terlindungi',
        profile_image_url: 'URL gambar profil', profile_url: 'URL profil'
    }
};

/**
 * Resolve a localized column label.
 * @param {string} key - the English data key (e.g. 'favorite_count')
 * @param {string} lang - target language code
 * @returns {string} localized label, English label, or the raw key
 */
function columnLabel(key, lang) {
    const L = COLUMN_LABELS[lang] || COLUMN_LABELS.en;
    return L[key] || COLUMN_LABELS.en[key] || key;
}

if (typeof globalThis !== 'undefined') {
    globalThis.XPorterColumns = { COLUMN_LABELS, columnLabel };
}
