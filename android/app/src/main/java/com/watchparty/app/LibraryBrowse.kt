package com.watchparty.app

/** Which part of the library is showing. */
enum class LibraryView(val label: String) { All("All videos"), Movies("Movies"), Shows("TV shows") }

enum class LibrarySort(val label: String) { Recent("Recently added"), AZ("A–Z"), Length("Length"), Size("Size") }

/**
 * A TV show built from the episodes whose file names say which show, season and episode they are. With TMDB,
 * folders it matches to the same show ("Franklin & Bash", "Franklin and Bash") are one show under TMDB's name;
 * [aliases] are the names from the file names, which extras are filed under.
 */
data class Show(val name: String, val episodes: List<MediaItem>, val aliases: List<String> = listOf(name)) {
    val meta: MediaMeta? = episodes.firstOrNull { it.meta != null }?.meta
    private val woven = weave(episodes)
    /** The real seasons, without 0. */
    val seasons: List<Int> = woven.seasons.keys.toList()
    /** Each season with the specials that aired during it, where they aired. */
    val bySeason: Map<Int, List<MediaItem>> = woven.seasons
    /** Season 0 by number: the Specials tab. */
    val specials: List<MediaItem> = woven.specials
    val addedAt: Long = episodes.maxOfOrNull { it.addedAt } ?: 0
    val size: Long = episodes.sumOf { it.size }
    val summary: String
        get() = "${plural(seasons.size, "season")} · ${plural(episodes.size, "episode")}"
}

/** One line in the library list: a film (or any video that isn't an episode), or a whole show. */
sealed interface LibraryRow {
    data class Video(val item: MediaItem) : LibraryRow
    data class ShowRow(val show: Show) : LibraryRow
}

fun plural(n: Int, word: String) = "$n $word" + if (n == 1) "" else "s"

/** "Movies/Action/Alien.mkv" -> "Movies"; files at the root have no folder. */
fun topFolder(item: MediaItem): String = item.folder.substringBefore('/')

private val byName = Comparator<String> { a, b -> naturalCompare(a, b) }

/** Case-insensitive, with numbers compared by value so "Episode 2" comes before "Episode 10". */
fun naturalCompare(a: String, b: String): Int {
    val re = Regex("\\d+|\\D+")
    val pa = re.findAll(a.lowercase()).map { it.value }.toList()
    val pb = re.findAll(b.lowercase()).map { it.value }.toList()
    for (i in 0 until minOf(pa.size, pb.size)) {
        val x = pa[i]
        val y = pb[i]
        val c = if (x[0].isDigit() && y[0].isDigit()) {
            x.trimStart('0').length.compareTo(y.trimStart('0').length).takeIf { it != 0 } ?: x.trimStart('0').compareTo(y.trimStart('0'))
        } else x.compareTo(y)
        if (c != 0) return c
    }
    return pa.size.compareTo(pb.size)
}

fun shows(items: List<MediaItem>): List<Show> =
    items.filter { it.episode != null }
        .groupBy { it.meta?.tmdbId?.let { id -> "tmdb:$id" } ?: it.episode!!.show }
        .map { (_, eps) ->
            Show(
                name = eps.firstNotNullOfOrNull { it.meta?.show } ?: eps.first().episode!!.show,
                // Watching order: the seasons, with specials where they aired (Binge all plays this).
                episodes = weave(eps).all,
                aliases = eps.map { it.episode!!.show }.distinct(),
            )
        }
        .sortedWith(compareBy(byName) { it.name })

/** A show's episodes in watching order (see [weave]). */
class Woven(val all: List<MediaItem>, val seasons: Map<Int, List<MediaItem>>, val specials: List<MediaItem>)

/**
 * Places each special (season 0) after the last episode that aired on or before its TMDB air date, so a binge plays
 * it where people first saw it. One that aired before the first episode starts that season; one without a date, or in
 * a show whose episodes have none, only goes at the end of the whole binge. Same as shared/specials.ts on the web.
 */
fun weave(episodes: List<MediaItem>): Woven {
    val regular = episodes.filter { it.episode!!.season > 0 }.sortedWith(compareBy({ it.episode!!.season }, { it.episode!!.episode }))
    val specials = episodes.filter { it.episode!!.season == 0 }.sortedBy { it.episode!!.episode }
    val after = mutableMapOf<Int, MutableList<MediaItem>>() // index into regular, -1 for before the first
    val undated = mutableListOf<MediaItem>()
    val dated = regular.any { it.meta?.airDate != null }
    for (s in specials) {
        val day = s.meta?.airDate
        if (day == null || !dated || regular.isEmpty()) {
            undated += s
            continue
        }
        val at = regular.indexOfLast { e -> e.meta?.airDate?.let { it <= day } == true }
        after.getOrPut(at) { mutableListOf() } += s
    }
    val all = mutableListOf<MediaItem>()
    val seasons = linkedMapOf<Int, MutableList<MediaItem>>()
    after[-1]?.let { first ->
        all += first
        seasons.getOrPut(regular.first().episode!!.season) { mutableListOf() } += first
    }
    regular.forEachIndexed { i, e ->
        val next = listOf(e) + (after[i] ?: emptyList())
        all += next
        seasons.getOrPut(e.episode!!.season) { mutableListOf() } += next
    }
    all += undated
    return Woven(all, seasons, specials)
}

/** "S2 E3", or "Special 3" for season 0. */
fun episodeLabel(season: Int, episode: Int): String = if (season == 0) "Special $episode" else "S$season E$episode"

/** A show's extras, filed under any of the names its folders have. */
fun extrasOfShow(show: Show, extras: Map<String, List<MediaItem>>): List<MediaItem>? =
    show.aliases.flatMap { extras[it] ?: emptyList() }.takeIf { it.isNotEmpty() }

/** A movie split into files is listed once, as its first part. */
val MediaItem.laterPart: Boolean get() = part != null && part.index > 1

/** An extra that belongs to a movie or show, so it's listed under that instead of on its own. */
val MediaItem.ownedExtra: Boolean get() = extra != null && (extra.of != null || extra.show != null)

/** Extras by the movie id or show name they belong to, sorted by title. */
fun extrasByOwner(items: List<MediaItem>): Map<String, List<MediaItem>> =
    items.filter { it.ownedExtra }.groupBy { it.extra!!.of ?: it.extra.show!! }.mapValues { (_, list) -> list.sortedWith(compareBy(byName) { it.title }) }

fun matches(item: MediaItem, query: String): Boolean {
    val q = query.trim()
    return q.isEmpty() || item.title.contains(q, ignoreCase = true) || item.relPath.contains(q, ignoreCase = true)
}

/** The list under the sort buttons. In All videos, each show is one row that opens its episodes. */
fun libraryRows(
    items: List<MediaItem>,
    view: LibraryView,
    folder: String?,
    subsOnly: Boolean,
    query: String,
    sort: LibrarySort,
): List<LibraryRow> {
    val list = items.filter {
        // While searching, matching extras show up on their own too.
        !it.laterPart && (folder == null || topFolder(it) == folder) && (query.isNotBlank() || !it.ownedExtra) &&
            (view == LibraryView.All || it.extra?.show == null) && (!subsOnly || it.subtitles.isNotEmpty()) && matches(it, query)
    }
    val rows = list.filter { it.episode == null }.map { LibraryRow.Video(it) } +
        if (view == LibraryView.All) shows(list).map { LibraryRow.ShowRow(it) } else emptyList()
    val name = { r: LibraryRow -> if (r is LibraryRow.Video) r.item.title else (r as LibraryRow.ShowRow).show.name }
    val byTitle = compareBy(byName, name)
    return when (sort) {
        LibrarySort.AZ -> rows.sortedWith(byTitle)
        LibrarySort.Recent -> rows.sortedWith(compareByDescending<LibraryRow> {
            if (it is LibraryRow.Video) it.item.addedAt else (it as LibraryRow.ShowRow).show.addedAt
        }.then(byTitle))
        LibrarySort.Length -> rows.sortedWith(compareByDescending<LibraryRow> {
            if (it is LibraryRow.Video) it.item.duration ?: -1.0 else -1.0
        }.then(byTitle))
        LibrarySort.Size -> rows.sortedWith(compareByDescending {
            if (it is LibraryRow.Video) it.item.size else (it as LibraryRow.ShowRow).show.size
        })
    }
}

/** The newest films for the Recently added row. */
fun recentlyAdded(items: List<MediaItem>, folder: String?, count: Int = 8): List<MediaItem> =
    items.filter { it.episode == null && it.extra == null && !it.laterPart && (folder == null || topFolder(it) == folder) }.sortedByDescending { it.addedAt }.take(count)

/** 7260.0 -> "2:01:00", 3000.0 -> "50:00" */
fun formatLength(seconds: Double): String {
    val s = seconds.toLong().coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    return if (h > 0) String.format("%d:%02d:%02d", h, m, s % 60) else String.format("%d:%02d", m, s % 60)
}
