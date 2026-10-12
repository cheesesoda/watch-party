package com.watchparty.app

/** Which part of the library is showing. */
enum class LibraryView(val label: String) { All("All videos"), Movies("Movies"), Shows("TV shows") }

enum class LibrarySort(val label: String) { Recent("Recently added"), AZ("A–Z"), Length("Length"), Size("Size") }

/** A TV show built from the episodes whose file names say which show, season and episode they are. */
data class Show(val name: String, val episodes: List<MediaItem>) {
    val seasons: List<Int> = episodes.map { it.episode!!.season }.distinct()
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
        .groupBy { it.episode!!.show }
        .map { (name, eps) -> Show(name, eps.sortedWith(compareBy({ it.episode!!.season }, { it.episode!!.episode }))) }
        .sortedWith(compareBy(byName) { it.name })

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
        (folder == null || topFolder(it) == folder) && (query.isNotBlank() || !it.ownedExtra) &&
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
    items.filter { it.episode == null && it.extra == null && (folder == null || topFolder(it) == folder) }.sortedByDescending { it.addedAt }.take(count)

/** 7260.0 -> "2:01:00", 3000.0 -> "50:00" */
fun formatLength(seconds: Double): String {
    val s = seconds.toLong().coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    return if (h > 0) String.format("%d:%02d:%02d", h, m, s % 60) else String.format("%d:%02d", m, s % 60)
}
