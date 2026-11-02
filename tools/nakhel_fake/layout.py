"""Plantation grid around Al Ain."""
AL_AIN_LAT = 24.2075
AL_AIN_LON = 55.7447
PALM_SPACING_DEG = 0.00008  # about 8 m


def grid_position(index, columns, origin=(AL_AIN_LAT, AL_AIN_LON)):
    """(lat, lon) of the index-th palm on a grid with the given number of columns."""
    row, col = divmod(index, columns)
    return (round(origin[0] + row * PALM_SPACING_DEG, 6),
            round(origin[1] + col * PALM_SPACING_DEG, 6))


def row_letters(index):
    """0 -> A, 25 -> Z, 26 -> AA, ..."""
    letters = ''
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def tree_label(index, columns):
    """E.g. PLM-A-07."""
    row, col = divmod(index, columns)
    return f'PLM-{row_letters(row)}-{col + 1:02d}'
