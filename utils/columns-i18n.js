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
        media_alt_texts: 'Media alt texts',
        article_title: 'Article title', article_url: 'Article URL', article_text: 'Article text',
        name: 'Name', username: 'Username', bio: 'Bio', location: 'Location', url: 'URL',
        followers_count: 'Followers', following_count: 'Following', tweet_count: 'Posts',
        listed_count: 'Lists', verified: 'Verified', protected: 'Protected',
        profile_image_url: 'Profile image URL', profile_url: 'Profile URL',
        account_based_in: 'Account based in', account_location_accurate: 'Account location accurate',
        premium_since: 'Premium since', account_source: 'Connected via',
        affiliate_username: 'Affiliate account', username_change_count: 'Username changes',
        username_last_changed_at: 'Username last changed'
    },
    ru: {
        id: 'ID', text: 'Текст', tweet_url: 'Ссылка на пост', language: 'Язык', type: 'Тип',
        author_name: 'Имя автора', author_username: 'Логин автора', view_count: 'Просмотры',
        bookmark_count: 'Закладки', favorite_count: 'Лайки', retweet_count: 'Репосты',
        reply_count: 'Ответы', quote_count: 'Цитаты', created_at: 'Дата', source: 'Источник',
        hashtags: 'Хэштеги', urls: 'Ссылки', media_type: 'Тип медиа', media_urls: 'Ссылки на медиа',
        media_alt_texts: 'Alt-тексты медиа',
        article_title: 'Заголовок статьи', article_url: 'Ссылка на статью', article_text: 'Текст статьи',
        name: 'Имя', username: 'Логин', bio: 'Описание', location: 'Местоположение', url: 'Ссылка',
        followers_count: 'Подписчики', following_count: 'Подписки', tweet_count: 'Посты',
        listed_count: 'Списки', verified: 'Верифицирован', protected: 'Закрытый',
        profile_image_url: 'Ссылка на аватар', profile_url: 'Ссылка на профиль',
        account_based_in: 'Страна или регион аккаунта', account_location_accurate: 'Точность региона аккаунта',
        premium_since: 'Premium с', account_source: 'Подключён через',
        affiliate_username: 'Связанный аккаунт', username_change_count: 'Смены имени пользователя',
        username_last_changed_at: 'Последняя смена имени пользователя'
    },
    zh: {
        id: 'ID', text: '文本', tweet_url: '帖子链接', language: '语言', type: '类型',
        author_name: '作者名称', author_username: '作者用户名', view_count: '浏览量',
        bookmark_count: '收藏数', favorite_count: '点赞数', retweet_count: '转发数',
        reply_count: '回复数', quote_count: '引用数', created_at: '日期', source: '来源',
        hashtags: '话题标签', urls: '链接', media_type: '媒体类型', media_urls: '媒体链接',
        media_alt_texts: '媒体替代文本',
        article_title: '文章标题', article_url: '文章链接', article_text: '文章文本',
        name: '名称', username: '用户名', bio: '简介', location: '位置', url: '网址',
        followers_count: '粉丝数', following_count: '关注数', tweet_count: '帖子数',
        listed_count: '列表数', verified: '已认证', protected: '受保护',
        profile_image_url: '头像链接', profile_url: '主页链接',
        account_based_in: '账号所在国家或地区', account_location_accurate: '账号位置准确性',
        premium_since: 'Premium 开通时间', account_source: '连接来源',
        affiliate_username: '关联账号', username_change_count: '用户名更改次数',
        username_last_changed_at: '用户名最后更改时间'
    },
    ja: {
        id: 'ID', text: '本文', tweet_url: '投稿URL', language: '言語', type: '種類',
        author_name: '投稿者名', author_username: '投稿者ユーザー名', view_count: '表示回数',
        bookmark_count: 'ブックマーク数', favorite_count: 'いいね数', retweet_count: 'リポスト数',
        reply_count: '返信数', quote_count: '引用数', created_at: '日付', source: 'ソース',
        hashtags: 'ハッシュタグ', urls: 'リンク', media_type: 'メディア種類', media_urls: 'メディアURL',
        media_alt_texts: 'メディアの代替テキスト',
        article_title: '記事タイトル', article_url: '記事URL', article_text: '記事本文',
        name: '名前', username: 'ユーザー名', bio: '自己紹介', location: '場所', url: 'URL',
        followers_count: 'フォロワー数', following_count: 'フォロー数', tweet_count: '投稿数',
        listed_count: 'リスト数', verified: '認証済み', protected: '非公開',
        profile_image_url: 'プロフィール画像URL', profile_url: 'プロフィールURL',
        account_based_in: 'アカウントの国または地域', account_location_accurate: 'アカウント地域の正確性',
        premium_since: 'Premium開始日', account_source: '接続元',
        affiliate_username: '関連アカウント', username_change_count: 'ユーザー名変更回数',
        username_last_changed_at: 'ユーザー名の最終変更日'
    },
    es: {
        id: 'ID', text: 'Texto', tweet_url: 'URL de la publicación', language: 'Idioma', type: 'Tipo',
        author_name: 'Nombre del autor', author_username: 'Usuario del autor', view_count: 'Visualizaciones',
        bookmark_count: 'Guardados', favorite_count: 'Me gusta', retweet_count: 'Reposts',
        reply_count: 'Respuestas', quote_count: 'Citas', created_at: 'Fecha', source: 'Fuente',
        hashtags: 'Hashtags', urls: 'Enlaces', media_type: 'Tipo de medio', media_urls: 'URLs de medios',
        media_alt_texts: 'Textos alternativos de medios',
        article_title: 'Título del artículo', article_url: 'URL del artículo', article_text: 'Texto del artículo',
        name: 'Nombre', username: 'Usuario', bio: 'Biografía', location: 'Ubicación', url: 'URL',
        followers_count: 'Seguidores', following_count: 'Siguiendo', tweet_count: 'Publicaciones',
        listed_count: 'Listas', verified: 'Verificado', protected: 'Protegido',
        profile_image_url: 'URL de la foto de perfil', profile_url: 'URL del perfil',
        account_based_in: 'País o región de la cuenta', account_location_accurate: 'Precisión de ubicación',
        premium_since: 'Premium desde', account_source: 'Conectado mediante',
        affiliate_username: 'Cuenta afiliada', username_change_count: 'Cambios de usuario',
        username_last_changed_at: 'Último cambio de usuario'
    },
    ko: {
        id: 'ID', text: '텍스트', tweet_url: '게시물 URL', language: '언어', type: '유형',
        author_name: '작성자 이름', author_username: '작성자 사용자명', view_count: '조회수',
        bookmark_count: '북마크수', favorite_count: '좋아요수', retweet_count: '리포스트수',
        reply_count: '답글수', quote_count: '인용수', created_at: '날짜', source: '출처',
        hashtags: '해시태그', urls: '링크', media_type: '미디어 유형', media_urls: '미디어 URL',
        media_alt_texts: '미디어 대체 텍스트',
        article_title: '아티클 제목', article_url: '아티클 URL', article_text: '아티클 텍스트',
        name: '이름', username: '사용자명', bio: '소개', location: '위치', url: 'URL',
        followers_count: '팔로워수', following_count: '팔로잉수', tweet_count: '게시물수',
        listed_count: '리스트수', verified: '인증됨', protected: '비공개',
        profile_image_url: '프로필 이미지 URL', profile_url: '프로필 URL',
        account_based_in: '계정 기반 국가 또는 지역', account_location_accurate: '계정 위치 정확성',
        premium_since: 'Premium 시작일', account_source: '연결 출처',
        affiliate_username: '제휴 계정', username_change_count: '사용자 이름 변경 횟수',
        username_last_changed_at: '사용자 이름 마지막 변경일'
    },
    it: {
        id: 'ID', text: 'Testo', tweet_url: 'URL del post', language: 'Lingua', type: 'Tipo',
        author_name: 'Nome autore', author_username: 'Username autore', view_count: 'Visualizzazioni',
        bookmark_count: 'Segnalibri', favorite_count: 'Mi piace', retweet_count: 'Repost',
        reply_count: 'Risposte', quote_count: 'Citazioni', created_at: 'Data', source: 'Fonte',
        hashtags: 'Hashtag', urls: 'Link', media_type: 'Tipo di media', media_urls: 'URL media',
        media_alt_texts: 'Testi alternativi media',
        article_title: 'Titolo articolo', article_url: 'URL articolo', article_text: 'Testo articolo',
        name: 'Nome', username: 'Username', bio: 'Bio', location: 'Posizione', url: 'URL',
        followers_count: 'Follower', following_count: 'Seguiti', tweet_count: 'Post',
        listed_count: 'Liste', verified: 'Verificato', protected: 'Protetto',
        profile_image_url: 'URL immagine profilo', profile_url: 'URL profilo',
        account_based_in: 'Paese o regione dell’account', account_location_accurate: 'Precisione posizione account',
        premium_since: 'Premium dal', account_source: 'Connesso tramite',
        affiliate_username: 'Account affiliato', username_change_count: 'Modifiche nome utente',
        username_last_changed_at: 'Ultima modifica nome utente'
    },
    pt: {
        id: 'ID', text: 'Texto', tweet_url: 'URL da publicação', language: 'Idioma', type: 'Tipo',
        author_name: 'Nome do autor', author_username: 'Usuário do autor', view_count: 'Visualizações',
        bookmark_count: 'Salvos', favorite_count: 'Curtidas', retweet_count: 'Reposts',
        reply_count: 'Respostas', quote_count: 'Citações', created_at: 'Data', source: 'Origem',
        hashtags: 'Hashtags', urls: 'Links', media_type: 'Tipo de mídia', media_urls: 'URLs de mídia',
        media_alt_texts: 'Textos alternativos de mídia',
        article_title: 'Título do artigo', article_url: 'URL do artigo', article_text: 'Texto do artigo',
        name: 'Nome', username: 'Usuário', bio: 'Bio', location: 'Localização', url: 'URL',
        followers_count: 'Seguidores', following_count: 'Seguindo', tweet_count: 'Publicações',
        listed_count: 'Listas', verified: 'Verificado', protected: 'Protegido',
        profile_image_url: 'URL da foto de perfil', profile_url: 'URL do perfil',
        account_based_in: 'País ou região da conta', account_location_accurate: 'Precisão da localização',
        premium_since: 'Premium desde', account_source: 'Conectado por',
        affiliate_username: 'Conta afiliada', username_change_count: 'Alterações de usuário',
        username_last_changed_at: 'Última alteração de usuário'
    },
    tr: {
        id: 'ID', text: 'Metin', tweet_url: 'Gönderi URL\'si', language: 'Dil', type: 'Tür',
        author_name: 'Yazar adı', author_username: 'Yazar kullanıcı adı', view_count: 'Görüntülenme',
        bookmark_count: 'Yer imleri', favorite_count: 'Beğeni', retweet_count: 'Repost',
        reply_count: 'Yanıt', quote_count: 'Alıntı', created_at: 'Tarih', source: 'Kaynak',
        hashtags: 'Hashtagler', urls: 'Bağlantılar', media_type: 'Medya türü', media_urls: 'Medya URL\'leri',
        media_alt_texts: 'Medya alternatif metinleri',
        article_title: 'Makale başlığı', article_url: 'Makale URL\'si', article_text: 'Makale metni',
        name: 'Ad', username: 'Kullanıcı adı', bio: 'Biyografi', location: 'Konum', url: 'URL',
        followers_count: 'Takipçi', following_count: 'Takip edilen', tweet_count: 'Gönderi',
        listed_count: 'Liste', verified: 'Doğrulanmış', protected: 'Gizli',
        profile_image_url: 'Profil resmi URL\'si', profile_url: 'Profil URL\'si',
        account_based_in: 'Hesabın bulunduğu ülke veya bölge', account_location_accurate: 'Hesap konumu doğruluğu',
        premium_since: 'Premium başlangıcı', account_source: 'Bağlantı kaynağı',
        affiliate_username: 'Bağlı hesap', username_change_count: 'Kullanıcı adı değişiklikleri',
        username_last_changed_at: 'Son kullanıcı adı değişikliği'
    },
    de: {
        id: 'ID', text: 'Text', tweet_url: 'Beitrags-URL', language: 'Sprache', type: 'Typ',
        author_name: 'Autorname', author_username: 'Autor-Benutzername', view_count: 'Aufrufe',
        bookmark_count: 'Lesezeichen', favorite_count: 'Gefällt mir', retweet_count: 'Reposts',
        reply_count: 'Antworten', quote_count: 'Zitate', created_at: 'Datum', source: 'Quelle',
        hashtags: 'Hashtags', urls: 'Links', media_type: 'Medientyp', media_urls: 'Medien-URLs',
        media_alt_texts: 'Medien-Alt-Texte',
        article_title: 'Artikeltitel', article_url: 'Artikel-URL', article_text: 'Artikeltext',
        name: 'Name', username: 'Benutzername', bio: 'Bio', location: 'Standort', url: 'URL',
        followers_count: 'Follower', following_count: 'Folgt', tweet_count: 'Beiträge',
        listed_count: 'Listen', verified: 'Verifiziert', protected: 'Geschützt',
        profile_image_url: 'Profilbild-URL', profile_url: 'Profil-URL',
        account_based_in: 'Land oder Region des Kontos', account_location_accurate: 'Genauigkeit des Kontostandorts',
        premium_since: 'Premium seit', account_source: 'Verbunden über',
        affiliate_username: 'Verbundenes Konto', username_change_count: 'Nutzernamenänderungen',
        username_last_changed_at: 'Letzte Nutzernamenänderung'
    },
    ar: {
        id: 'المعرف', text: 'النص', tweet_url: 'رابط المنشور', language: 'اللغة', type: 'النوع',
        author_name: 'اسم الكاتب', author_username: 'معرف الكاتب', view_count: 'المشاهدات',
        bookmark_count: 'الإشارات المرجعية', favorite_count: 'الإعجابات', retweet_count: 'إعادات النشر',
        reply_count: 'الردود', quote_count: 'الاقتباسات', created_at: 'التاريخ', source: 'المصدر',
        hashtags: 'الوسوم', urls: 'الروابط', media_type: 'نوع الوسائط', media_urls: 'روابط الوسائط',
        media_alt_texts: 'النصوص البديلة للوسائط',
        article_title: 'عنوان المقالة', article_url: 'رابط المقالة', article_text: 'نص المقالة',
        name: 'الاسم', username: 'اسم المستخدم', bio: 'النبذة', location: 'الموقع', url: 'الرابط',
        followers_count: 'المتابِعون', following_count: 'المتابَعون', tweet_count: 'المنشورات',
        listed_count: 'القوائم', verified: 'موثّق', protected: 'محمي',
        profile_image_url: 'رابط صورة الملف الشخصي', profile_url: 'رابط الملف الشخصي',
        account_based_in: 'بلد أو منطقة الحساب', account_location_accurate: 'دقة موقع الحساب',
        premium_since: 'Premium منذ', account_source: 'متصل عبر',
        affiliate_username: 'الحساب التابع', username_change_count: 'تغييرات اسم المستخدم',
        username_last_changed_at: 'آخر تغيير لاسم المستخدم'
    },
    fr: {
        id: 'ID', text: 'Texte', tweet_url: 'URL du post', language: 'Langue', type: 'Type',
        author_name: 'Nom de l\'auteur', author_username: 'Identifiant de l\'auteur', view_count: 'Vues',
        bookmark_count: 'Signets', favorite_count: 'J\'aime', retweet_count: 'Reposts',
        reply_count: 'Réponses', quote_count: 'Citations', created_at: 'Date', source: 'Source',
        hashtags: 'Hashtags', urls: 'Liens', media_type: 'Type de média', media_urls: 'URLs des médias',
        media_alt_texts: 'Textes alternatifs des médias',
        article_title: 'Titre de l\'article', article_url: 'URL de l\'article', article_text: 'Texte de l\'article',
        name: 'Nom', username: 'Identifiant', bio: 'Bio', location: 'Localisation', url: 'URL',
        followers_count: 'Abonnés', following_count: 'Abonnements', tweet_count: 'Posts',
        listed_count: 'Listes', verified: 'Vérifié', protected: 'Protégé',
        profile_image_url: 'URL de la photo de profil', profile_url: 'URL du profil',
        account_based_in: 'Pays ou région du compte', account_location_accurate: 'Précision de la localisation',
        premium_since: 'Premium depuis', account_source: 'Connecté via',
        affiliate_username: 'Compte affilié', username_change_count: 'Changements d’identifiant',
        username_last_changed_at: 'Dernier changement d’identifiant'
    },
    hi: {
        id: 'ID', text: 'टेक्स्ट', tweet_url: 'पोस्ट URL', language: 'भाषा', type: 'प्रकार',
        author_name: 'लेखक का नाम', author_username: 'लेखक का यूज़रनेम', view_count: 'व्यूज़',
        bookmark_count: 'बुकमार्क', favorite_count: 'लाइक', retweet_count: 'रीपोस्ट',
        reply_count: 'रिप्लाई', quote_count: 'कोट', created_at: 'तारीख़', source: 'स्रोत',
        hashtags: 'हैशटैग', urls: 'लिंक', media_type: 'मीडिया प्रकार', media_urls: 'मीडिया URL',
        media_alt_texts: 'मीडिया वैकल्पिक टेक्स्ट',
        article_title: 'लेख का शीर्षक', article_url: 'लेख URL', article_text: 'लेख का पाठ',
        name: 'नाम', username: 'यूज़रनेम', bio: 'बायो', location: 'स्थान', url: 'URL',
        followers_count: 'फ़ॉलोअर्स', following_count: 'फ़ॉलोइंग', tweet_count: 'पोस्ट',
        listed_count: 'लिस्ट', verified: 'सत्यापित', protected: 'संरक्षित',
        profile_image_url: 'प्रोफ़ाइल इमेज URL', profile_url: 'प्रोफ़ाइल URL',
        account_based_in: 'खाते का देश या क्षेत्र', account_location_accurate: 'खाते के स्थान की सटीकता',
        premium_since: 'Premium शुरू होने की तारीख', account_source: 'कनेक्शन स्रोत',
        affiliate_username: 'संबद्ध खाता', username_change_count: 'यूज़रनेम बदलाव',
        username_last_changed_at: 'अंतिम यूज़रनेम बदलाव'
    },
    id: {
        id: 'ID', text: 'Teks', tweet_url: 'URL postingan', language: 'Bahasa', type: 'Tipe',
        author_name: 'Nama penulis', author_username: 'Username penulis', view_count: 'Tayangan',
        bookmark_count: 'Markah', favorite_count: 'Suka', retweet_count: 'Repost',
        reply_count: 'Balasan', quote_count: 'Kutipan', created_at: 'Tanggal', source: 'Sumber',
        hashtags: 'Tagar', urls: 'Tautan', media_type: 'Tipe media', media_urls: 'URL media',
        media_alt_texts: 'Teks alternatif media',
        article_title: 'Judul artikel', article_url: 'URL artikel', article_text: 'Teks artikel',
        name: 'Nama', username: 'Username', bio: 'Bio', location: 'Lokasi', url: 'URL',
        followers_count: 'Pengikut', following_count: 'Mengikuti', tweet_count: 'Postingan',
        listed_count: 'Daftar', verified: 'Terverifikasi', protected: 'Terlindungi',
        profile_image_url: 'URL gambar profil', profile_url: 'URL profil',
        account_based_in: 'Negara atau wilayah akun', account_location_accurate: 'Akurasi lokasi akun',
        premium_since: 'Premium sejak', account_source: 'Terhubung melalui',
        affiliate_username: 'Akun afiliasi', username_change_count: 'Perubahan nama pengguna',
        username_last_changed_at: 'Perubahan nama pengguna terakhir'
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
